import { describe, expect, it } from "vite-plus/test";
import { withFeatureDivider } from "../src/lib/features/origin";

describe("withFeatureDivider", () => {
  it("puts core first, then one divider, then the feature items", () => {
    expect(withFeatureDivider(["a", "b"], ["x", "y"], "|")).toEqual(["a", "b", "|", "x", "y"]);
  });

  it("has no divider unless both sides have items", () => {
    expect(withFeatureDivider(["a"], [], "|")).toEqual(["a"]);
    expect(withFeatureDivider([], ["x"], "|")).toEqual(["x"]);
    expect(withFeatureDivider([], [], "|")).toEqual([]);
  });
});
