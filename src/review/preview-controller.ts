import type { BuildResult, RiverbankRecipe } from "../gaussian/types";
import type { ResolvedReview } from "./draft";
import type { SceneReviewRecord } from "./history";
import { errorText } from "../planner/service";
import { freeze } from "../assets/catalog/metadata";

export interface StagedPreview {
  commit: () => void;
  rollback: () => void;
  isUsable: () => boolean;
}
export interface PreviewPorts<
  Review extends { recipe: RiverbankRecipe } = ResolvedReview,
  Saved = SceneReviewRecord,
> {
  build: (recipe: RiverbankRecipe, signal: AbortSignal) => Promise<BuildResult>;
  stage: (result: BuildResult, signal: AbortSignal) => Promise<StagedPreview>;
  record: (review: Review) => Promise<Saved>;
  publish: (result: BuildResult, record: Saved) => void;
  persist: (
    record: Saved,
  ) => Promise<{ error: string | null; notice: string | null }>;
}
type Phase = "idle" | "building" | "preview" | "committing";
type UseResult<Saved> = {
  record: Saved;
  saveError: string | null;
  notice: string | null;
};
export interface PreviewController<
  Review = ResolvedReview,
  Saved = SceneReviewRecord,
> {
  preview: (review: Review) => Promise<{ ticket: number; result: BuildResult }>;
  cancel: () => void;
  use: (ticket: number) => Promise<UseResult<Saved>>;
  getState: () => { phase: Phase; ticket: number | null };
}
interface Transaction<Review> {
  ticket: number;
  controller: AbortController;
  review: Review;
  result?: BuildResult;
  staged?: StagedPreview;
  phase: Exclude<Phase, "idle">;
}
const stale = () =>
  new DOMException("预览已取消、过期或不可显示，未使用此场景。", "AbortError");

export function createPreviewController<
  Review extends { recipe: RiverbankRecipe } = ResolvedReview,
  Saved = SceneReviewRecord,
>(ports: PreviewPorts<Review, Saved>): PreviewController<Review, Saved> {
  let sequence = 0,
    active: Transaction<Review> | null = null;
  let persistence: Promise<unknown> = Promise.resolve();
  const uses = new Map<number, Promise<UseResult<Saved>>>();
  const owns = (t: Transaction<Review>) =>
    active === t && !t.controller.signal.aborted;
  function discard(t: Transaction<Review>) {
    if (active !== t) return;
    active = null;
    t.controller.abort();
    t.staged?.rollback();
  }
  function cancel() {
    sequence++;
    if (active) discard(active);
  }
  function assertUsable(t: Transaction<Review>) {
    if (!owns(t) || !t.staged?.isUsable() || !t.result) throw stale();
  }
  return {
    cancel,
    getState: () => ({
      phase: active?.phase ?? "idle",
      ticket: active?.ticket ?? null,
    }),
    async preview(review) {
      cancel();
      const t: Transaction<Review> = {
        ticket: ++sequence,
        controller: new AbortController(),
        review: freeze(structuredClone(review)),
        phase: "building",
      };
      active = t;
      try {
        const result = await ports.build(t.review.recipe, t.controller.signal);
        if (!owns(t)) throw stale();
        const staged = await ports.stage(result, t.controller.signal);
        if (!owns(t)) {
          staged.rollback();
          throw stale();
        }
        t.result = result;
        t.staged = staged;
        assertUsable(t);
        t.phase = "preview";
        return { ticket: t.ticket, result };
      } catch (e) {
        discard(t);
        throw e;
      }
    },
    use(ticket) {
      const existing = uses.get(ticket);
      if (existing) return existing;
      const t = active;
      if (!t || t.ticket !== ticket || t.phase !== "preview")
        return Promise.reject(stale());
      const operation = (async (): Promise<UseResult<Saved>> => {
        try {
          assertUsable(t);
          t.phase = "committing";
          const record = await ports.record(t.review);
          assertUsable(t);
          // No await between the ownership check, GPU commit and CPU publication.
          t.staged!.commit();
          active = null;
          ports.publish(t.result!, record);
          const saved = persistence
            .then(() => ports.persist(record))
            .catch((e) => ({
              error: `审阅记录未保存，请下载记录：${errorText(e)}`,
              notice: null,
            }));
          persistence = saved;
          const outcome = await saved;
          return { record, saveError: outcome.error, notice: outcome.notice };
        } catch (e) {
          discard(t);
          throw e;
        }
      })();
      const tracked = operation.finally(() => uses.delete(ticket));
      uses.set(ticket, tracked);
      return tracked;
    },
  };
}
