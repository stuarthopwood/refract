import { describe, expect, it } from "vitest"
import { hasClassToken } from "./classToken"
import {
  CHECKED_ITEM_CLASS,
  MENU_CONTENT_CLASS,
  MENU_FORCED_FOCUS_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DESTRUCTIVE_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
  MENU_SUB_TRIGGER_CLASS,
} from "./menu-item-classes"

describe("shared menu classes (#2173)", () => {
  it("draws separators in the app divider colour and keeps them visible in forced colours", () => {
    expect(hasClassToken(MENU_SEPARATOR_CLASS, "bg-divider")).toBe(true)
    expect(hasClassToken(MENU_SEPARATOR_CLASS, "bg-border")).toBe(false)
    expect(hasClassToken(MENU_SEPARATOR_CLASS, "forced-colors:bg-[CanvasText]")).toBe(true)
  })

  it.each([MENU_CONTENT_CLASS, MENU_SUB_CONTENT_CLASS])("lifts the menu box onto the menu surface", (box) => {
    expect(hasClassToken(box, "bg-menu-surface")).toBe(true)
    expect(hasClassToken(box, "bg-popover")).toBe(false)
  })

  it("fills the focused row with the menu hover wash, not the accent", () => {
    expect(hasClassToken(MENU_ITEM_CLASS, "focus:bg-menu-hover")).toBe(true)
    expect(hasClassToken(MENU_ITEM_CLASS, "focus:bg-accent")).toBe(false)
  })

  it("fills the open sub-trigger with the hover wash and never the accent", () => {
    expect(hasClassToken(MENU_SUB_TRIGGER_CLASS, "data-[state=open]:bg-menu-hover")).toBe(true)
    expect(hasClassToken(MENU_SUB_TRIGGER_CLASS, "data-[state=open]:bg-accent")).toBe(false)
    expect(hasClassToken(MENU_SUB_TRIGGER_CLASS, "bg-accent")).toBe(false)
    expect(hasClassToken(MENU_SUB_TRIGGER_CLASS, "focus:bg-accent")).toBe(false)
  })

  it("gives the focused row a Highlight outline in forced colours", () => {
    expect(hasClassToken(MENU_ITEM_CLASS, "forced-colors:focus:outline-[color:Highlight]")).toBe(true)
    expect(hasClassToken(MENU_FORCED_FOCUS_CLASS, "forced-colors:focus:outline-(length:--focus-ring-width)")).toBe(true)
  })

  it("keeps checked items on an accent label with no fill, reverting to foreground on the focus wash", () => {
    expect(hasClassToken(CHECKED_ITEM_CLASS, "data-[state=checked]:text-accent-text")).toBe(true)
    expect(hasClassToken(CHECKED_ITEM_CLASS, "data-[state=checked]:focus:text-foreground")).toBe(true)
    expect(hasClassToken(CHECKED_ITEM_CLASS, "data-[state=checked]:focus:text-accent-foreground")).toBe(false)
    expect(CHECKED_ITEM_CLASS).not.toMatch(/(?<!\S)(?:\S+:)?bg-/)
  })

  it("tints a focused destructive item with a destructive wash and keeps its text destructive", () => {
    expect(hasClassToken(MENU_ITEM_DESTRUCTIVE_CLASS, "data-[variant=destructive]:focus:bg-destructive/3")).toBe(true)
    expect(hasClassToken(MENU_ITEM_DESTRUCTIVE_CLASS, "data-[variant=destructive]:focus:text-destructive")).toBe(true)
    expect(hasClassToken(MENU_ITEM_DESTRUCTIVE_CLASS, "data-[variant=destructive]:text-destructive")).toBe(true)
    expect(MENU_ITEM_DESTRUCTIVE_CLASS).not.toContain("bg-accent")
  })

  it("matches whole class tokens only, so a translucent popover never reads as the opaque one", () => {
    expect(hasClassToken("rounded bg-popover/50", "bg-popover")).toBe(false)
    expect(hasClassToken("rounded bg-popover", "bg-popover")).toBe(true)
  })
})
