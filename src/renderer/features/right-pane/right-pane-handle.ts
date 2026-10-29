import { createRef } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'

// The right `ResizablePanel`'s imperative handle (App.tsx attaches it). A module singleton so the
// pane-width menus (PaneWidthMenu.tsx) can resize the pane without a prop chain through App.tsx.
export const rightPaneRef = createRef<PanelImperativeHandle>()
