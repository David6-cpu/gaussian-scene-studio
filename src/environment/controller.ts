import type { Camera, EnvironmentAsset, EnvironmentRecord } from "./asset";
export interface EnvironmentStage {
  commit(): void;
  rollback(): void;
  usable(): boolean;
  camera(): Camera;
}
export interface EnvironmentState {
  phase: "idle" | "loading" | "preview" | "saving" | "saved";
  asset: EnvironmentAsset | null;
}
export function createEnvironmentController(ports: {
  stage(
    asset: EnvironmentAsset,
    signal: AbortSignal,
    camera?: Camera,
  ): Promise<EnvironmentStage>;
  persist(record: EnvironmentRecord): Promise<{ duplicate: boolean }>;
  changed(state: EnvironmentState): void;
}) {
  type Active = {
    asset: EnvironmentAsset;
    abort: AbortController;
    staged?: EnvironmentStage;
    saving?: Promise<{
      record: EnvironmentRecord;
      duplicate: boolean;
      applied: boolean;
    }>;
  };
  let active: Active | null = null,
    committed: EnvironmentRecord | null = null;
  let state: EnvironmentState = { phase: "idle", asset: null };
  const emit = (next: EnvironmentState) => {
    state = next;
    ports.changed(next);
  };
  const stale = () =>
    new DOMException("环境预览已取消或被替换。", "AbortError");
  const owns = (t: Active) => active === t && !t.abort.signal.aborted;
  const discard = () => {
    const t = active;
    active = null;
    if (t) {
      t.abort.abort();
      t.staged?.rollback();
    }
  };
  function cancel() {
    discard();
    emit({
      phase: committed ? "saved" : "idle",
      asset: committed?.asset ?? null,
    });
  }
  return {
    getState: () => state,
    cancel,
    close() {
      committed = null;
      cancel();
    },
    async preview(asset: EnvironmentAsset, camera?: Camera) {
      discard();
      const t: Active = {
        asset: structuredClone(asset),
        abort: new AbortController(),
      };
      active = t;
      emit({ phase: "loading", asset: t.asset });
      try {
        const staged = await ports.stage(t.asset, t.abort.signal, camera);
        if (!owns(t)) {
          staged.rollback();
          throw stale();
        }
        t.staged = staged;
        if (!staged.usable()) throw Error("环境尚未实际显示，不能采用。");
        emit({ phase: "preview", asset: t.asset });
      } catch (e) {
        if (owns(t)) cancel();
        throw e;
      }
    },
    save() {
      const t = active;
      if (t?.saving) return t.saving;
      if (!t?.staged || state.phase !== "preview" || !t.staged.usable())
        return Promise.reject(Error("请先完成环境预览。"));
      const record: EnvironmentRecord = {
        asset: t.asset,
        camera: t.staged.camera(),
        savedAt: new Date().toISOString(),
      };
      emit({ phase: "saving", asset: t.asset });
      const work = (async () => {
        try {
          const result = await ports.persist(record);
          if (!owns(t)) return { record, ...result, applied: false };
          if (!t.staged!.usable())
            throw Error("记录已保存，但显示已中断；请重新打开。");
          t.staged!.commit();
          active = null;
          committed = record;
          emit({ phase: "saved", asset: t.asset });
          return { record, ...result, applied: true };
        } catch (e) {
          if (owns(t)) emit({ phase: "preview", asset: t.asset });
          throw e;
        } finally {
          t.saving = undefined;
        }
      })();
      t.saving = work;
      return work;
    },
  };
}
