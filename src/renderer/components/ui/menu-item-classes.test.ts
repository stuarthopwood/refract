import { describe, expect, it } from "vitest"
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
  MENU_SUB_TRIGGER_CLASS,
} from "./menu-item-classes"

describe("shared menu classes (#2173)", () => {
  it("draws separators in the app divider colour", () => {
    expect(MENU_SEPARATOR_CLASS).toContain("bg-divider")
    expect(MENU_SEPARATOR_CLASS).not.toContain("bg-border")
  })

  it.each([MENU_CONTENT_CLASS, MENU_SUB_CONTENT_CLASS])("lifts the menu box onto the menu surface", (box) => {
    expect(box).toContain("bg-menu-surface")
    expect(box).not.toContain("bg-popover")
  })

  it("fills the focused and open rows with the menu hover wash, not the accent", () => {
    expect(MENU_ITEM_CLASS).toContain("focus:bg-menu-hover")
    expect(MENU_ITEM_CLASS).not.toContain("focus:bg-accent")
    expect(MENU_SUB_TRIGGER_CLASS).toContain("data-[state=open]:bg-menu-hover")
  })
})
