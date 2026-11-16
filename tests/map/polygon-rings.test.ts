import { describe, expect, it } from "vitest";
import { separatePolygonRings } from "../../src/render/polygon-rings";

describe("polygon outer rings and holes", () => {
  it("separates the outer ring from all valid inner rings", () => {
    const outer = [[0, 0], [4, 0], [4, 4]];
    const firstHole = [[1, 1], [2, 1], [2, 2]];
    const secondHole = [[3, 1], [3.5, 1], [3, 1.5]];
    const invalidHole = [[0, 0], [1, 1]];

    expect(separatePolygonRings([outer, firstHole, secondHole, invalidHole])).toEqual({
      outer,
      holes: [firstHole, secondHole],
    });
  });

  it("ignores polygons without a valid outer ring", () => {
    expect(separatePolygonRings([[[0, 0], [1, 1]]])).toEqual({ outer: undefined, holes: [] });
  });
});
