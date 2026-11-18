Macusanite 0.1.14. The edge panels share one dock, and the navigator's placement and width are yours to set. Signed Windows and Linux installers with updater support.

## Highlights
- **Settings → Worldbuilding → Navigator placement** chooses where the map sits: a **drawer** on the canvas's right edge, or a **floating** card in its corner. It used to be reachable only through a Pop out button you had to already be in the panel to find.
- The **drawer is resizable.** Drag the grip on its inner edge, or focus it and press ← and →, and the width is remembered with the vault as `worldbuild.navigatorWidth`.
- **One dock underneath all four edge panels.** The sidebar fold, the graph fold, the navigator drawer and the inspector overlay now share one rail, one tab shape, one slide and one set of states, so the next panel costs a label rather than a second copy of the geometry. Nothing about how they look changes.
- **Narrow windows are handled.** At 1100 px and below the dock's panels cap to a share of the window, a floating map moves clear of the column the dock owns, and a rail shorter than its two tabs scrolls from the first instead of clipping it. Turning the map on while the inspector holds the edge now shows the map instead of leaving it docked underneath.

Linux users can choose the AppImage or Debian package. Both are signed, and the updater manifest includes Windows and Linux.
