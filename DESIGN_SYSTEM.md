# NetWatch UI system

## Principle

Stylish, functional minimalism. Media and controls carry the interface; explanatory copy does not.

## Copy

- No slogans, welcome copy, or marketing filler.
- Do not explain self-evident controls.
- Prefer short nouns and states: `VPN`, `Streams`, `Ready`, `Retry`.
- Put technical detail in diagnostics/error states, not normal navigation.
- Accessibility labels may be more descriptive than visible labels.

## Visual language

- Graphite/near-black surfaces.
- Warm white primary text and cool neutral secondary text.
- Violet is the single accent for selection, focus, progress, and identity.
- Artwork provides most visual richness.
- Borders before shadows; shadows before glow.
- Motion is short and functional, never ornamental.

## Shape and spacing

- 5–10 px radii for controls, ~14 px for media/surfaces, 18 px only for large containers.
- Avoid pills unless the interaction is inherently segmented/tag-like.
- Avoid nested decorative cards.
- Keep settings, diagnostics, and player popovers compact.

## Brand mark

Use the white ghost mascot with near-black inner outline and purple-gradient outer stroke for the Windows application, installer, shortcuts, title bar, renderer, and player identity. Do not introduce a second play-button/media-glyph logo.

## Information architecture

- Sidebar navigation is `Home`, `Discover`, `Settings`.
- Home keeps the established media shelves and has the shared top search bar.
- Discover uses the same search bar plus media/category/genre selectors and the existing NetWatch card grid.
- Search results are a transient screen, not a sidebar destination.
- Visible terminology is `TV`, not `Series`; internal route/type names may remain `series`.
- Media cards show artwork, compact type badge, title, year, and original language. Full metadata belongs on the detail view.
- The established TV/anime episode browser should not be structurally redesigned without a dedicated review.

## VPN settings

- `Generic WireGuard` and `VPNBook` are profile labels over the same WireGuard security path.
- Show VPNBook expiry as an estimate/reminder, never as a security verdict.
- Keep provider switching lightweight; it changes guidance/metadata, not routing.
- Configuration replacement is explicit and followed by a restart action; do not imply a live tunnel was hot-swapped.
- Provider-specific links are fixed application actions, not arbitrary renderer URLs.

## Player

- Preparation/rebuffering is an exclusive backdrop state; normal player chrome stays hidden.
- Fullscreen must remain available during preparation.
- Metadata acquisition uses an indeterminate pulse; never fabricate percentage progress before real progress exists.
- Audio and subtitles share the compact `Tracks` popover.
- Live torrent telemetry belongs in the compact `Network` popover.
- Space always controls play/pause; focused controls must not consume it as button activation.
- Skip controls represent their actual ±10-second behavior.
- Player menus close with Escape or an outside click without toggling playback.

## Effects

Allowed by default:

- subtle poster scale on hover;
- restrained active/focus tint;
- short popover/drawer/fade transitions;
- artwork/backdrop shading for legibility.

Avoid:

- animated gradients;
- glow borders;
- glass-on-glass stacks;
- decorative blur fields;
- bounce/spring motion for routine controls;
- accent color on every interactive element.
