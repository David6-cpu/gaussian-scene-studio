import { record } from "../data-validation";
import { freeze } from "../assets/catalog/metadata";
import {
  materialKeys,
  parseAssetMaterials,
  assetRequestSchema,
  defaultAssetRequest,
  type AssetMaterials,
} from "../selection/contract";
import { parseWaterRequirement, type WaterRequirement } from "./water";
export type ReviewRequestV2 = AssetMaterials & { water: WaterRequirement };
export function parseReviewRequestV2(value: unknown): ReviewRequestV2 {
  const r = record(value, [...materialKeys, "water"]);
  return freeze({
    ...parseAssetMaterials(
      Object.fromEntries(materialKeys.map((key) => [key, r[key]])),
    ),
    water: parseWaterRequirement(r.water),
  });
}
const { waterLevel: _old, ...materials } = defaultAssetRequest;
export const defaultReviewRequestV2 = parseReviewRequestV2({
  ...materials,
  water: { mode: "unspecified", explicitLevel: null },
});
export const reviewRequestSchemaV2 = {
  type: "object",
  additionalProperties: false,
  required: [...materialKeys, "water"],
  properties: {
    ...Object.fromEntries(
      materialKeys.map((key) => [
        key,
        assetRequestSchema.properties[
          key as keyof typeof assetRequestSchema.properties
        ],
      ]),
    ),
    water: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "explicitLevel"],
      properties: {
        mode: {
          type: "string",
          enum: ["river", "surface", "none", "unspecified"],
        },
        explicitLevel: {
          type: ["number", "null"],
          minimum: -0.5,
          maximum: 0.5,
        },
      },
    },
  },
};
