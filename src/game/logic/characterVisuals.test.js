import { describe, expect, it } from "vitest";
import {
  getHeroAttackVisual,
  getHeroIdleVisual,
  getHeroPortraitVisual,
  getHeroRunVisual,
} from "./characterVisuals.js";

describe("character visuals", () => {
  it("uses the Fighter sprite for every fighter visual state", () => {
    const visuals = [
      getHeroIdleVisual("fighter"),
      getHeroPortraitVisual("fighter"),
      getHeroAttackVisual("fighter", () => 0),
      getHeroRunVisual("fighter"),
    ];

    for (const visual of visuals) {
      expect(visual).toMatchObject({
        sprite: "/assets/characters/fighter/Fighter.png",
        scale: 1.0,
      });
      expect(visual.animation).toBeUndefined();
    }
  });
});
