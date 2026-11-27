/** The slice of a React event the suppression reads: `preventDefault` makes Radix skip its own handler. */
interface HandledEvent {
  preventDefault(): void
}

/** Click suppression for a hover card: after a click the card stays closed until the pointer leaves and returns; focus caused by that click never opens it, keyboard focus still does. */
export interface ClickSuppression {
  /** An open request (pointer or focus timer) must be ignored. */
  blocksOpen(): boolean
  onPointerDown(): void
  onClick(): void
  onPointerLeave(): void
  onFocus(event: HandledEvent): void
}

/** `close` shuts the card the moment the row is pressed, so a card that was already open does not cover the Session just chosen. */
export function createClickSuppression(close: () => void): ClickSuppression {
  let clicked = false
  // pointerdown precedes the focus it causes; the flag lets that one focus event through unopened.
  let pointerFocusPending = false
  return {
    blocksOpen: () => clicked,
    onPointerDown() {
      clicked = true
      pointerFocusPending = true
      close()
    },
    // A button that was already focused gets no focus event, so the flag must not outlive the click.
    onClick() {
      pointerFocusPending = false
    },
    onPointerLeave() {
      clicked = false
      pointerFocusPending = false
    },
    onFocus(event) {
      if (pointerFocusPending) {
        pointerFocusPending = false
        event.preventDefault()
        return
      }
      // Keyboard focus ends the click's hold even while the pointer still rests on the row.
      clicked = false
    }
  }
}
