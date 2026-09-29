// Icon set ported 1:1 from the design's icon definitions so glyphs match exactly:
// viewBox 0 0 24 24, 1.8 stroke, round caps/joins, currentColor. Each entry is the
// raw inner SVG markup (paths/rects/circles/ellipses) copied verbatim; filled marks
// set fill/stroke explicitly. Icons are decorative — the surrounding control owns
// the accessible name — so every svg is aria-hidden.
const ICONS = {
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none"/>',
  send: '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>',
  receive: '<path d="M17 7L7 17"/><path d="M15 17H7V9"/>',
  activity: '<path d="M3 12h4l2.5 6 4-14 2.5 8H21"/>',
  settings: '<path d="M4 7h9"/><circle cx="16" cy="7" r="2.4"/><path d="M18.5 7H21"/><path d="M4 17h4"/><circle cx="11" cy="17" r="2.4"/><path d="M13.5 17H21"/>',
  coins: '<ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5"/><path d="M5 11.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  atom: '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="9" ry="3.7"/><ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(120 12 12)"/>',
  refresh: '<path d="M20 11a8 8 0 1 0 -.7 4"/><path d="M20 5v6h-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V5a2 2 0 0 1 2 -2h8"/>',
  chevdown: '<path d="M6 9l6 6 6 -6"/>',
  chevleft: '<path d="M14 6l-6 6 6 6"/>',
  chevright: '<path d="M10 6l6 6 -6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
  moon: '<path d="M18 14.5a7 7 0 0 1 -9.5 -9 7 7 0 1 0 9.5 9z"/>',
  check: '<path d="M5 12l4.5 4.5L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  snow: '<path d="M12 2v20"/><path d="M3.8 7l16.4 10"/><path d="M20.2 7L3.8 17"/><path d="M9 3.6l3 3 3-3"/><path d="M9 20.4l3-3 3 3"/><path d="M3.6 9.2l1.1 4.1M20.4 9.2l-1.1 4.1"/><path d="M3.6 14.8l1.1-4.1M20.4 14.8l-1.1-4.1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/>',
  external: '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M19 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9s1.3-6.5 3.8-9z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="1" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 2L5 13h5l-1 9 9-12h-5l1-8z"/>',
  onion: '<path d="M12 21c4 0 6.6-2.8 6.6-6.6 0-4.6-3.4-7.4-6.6-11.4-3.2 4-6.6 6.8-6.6 11.4C5.4 18.2 8 21 12 21z"/><path d="M9.4 14c0 2 1.2 3.6 2.6 3.6s2.6-1.6 2.6-3.6"/><path d="M12 3.2c.5 1 1.3 1.6 2.1 2"/>',
  shield: '<path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z"/>',
  retry: '<path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v5h5"/>',
  contact: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/>',
  alert: '<path d="M12 3.5l9 15.5H3l9-15.5z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r="0.7" fill="currentColor" stroke="none"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M18 5l2 2"/><path d="M15 8l2 2"/>',
  trash: '<path d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"/>',
} satisfies Record<string, string>

export type IconName = keyof typeof ICONS

// Generic icon renderer. Pass `color` to override the inherited currentColor.
export function Icon({ name, size = 18, color }: { name: IconName; size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={color !== undefined ? { color } : undefined}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  )
}

// Named wrappers for ergonomic, type-safe use at call sites.
function make(name: IconName) {
  const C = ({ size, color }: { size?: number; color?: string }) => <Icon name={name} size={size} color={color} />
  C.displayName = `${name}Icon`
  return C
}

export const WalletIcon = make('wallet')
export const SendIcon = make('send')
export const ReceiveIcon = make('receive')
export const ActivityIcon = make('activity')
export const SettingsIcon = make('settings')
export const CoinsIcon = make('coins')
export const LockIcon = make('lock')
export const AtomIcon = make('atom')
export const RefreshIcon = make('refresh')
export const CopyIcon = make('copy')
export const ChevDownIcon = make('chevdown')
export const ChevLeftIcon = make('chevleft')
export const ChevRightIcon = make('chevright')
export const SunIcon = make('sun')
export const MoonIcon = make('moon')
export const CheckIcon = make('check')
export const PlusIcon = make('plus')
export const SnowIcon = make('snow')
export const SearchIcon = make('search')
export const EyeIcon = make('eye')
export const EyeOffIcon = make('eyeoff')
export const PencilIcon = make('pencil')
export const ExternalIcon = make('external')
export const CloseIcon = make('close')
export const GlobeIcon = make('globe')
export const ServerIcon = make('server')
export const BoltIcon = make('bolt')
export const OnionIcon = make('onion')
export const ShieldIcon = make('shield')
export const RetryIcon = make('retry')
export const ContactIcon = make('contact')
export const AlertIcon = make('alert')
export const KeyIcon = make('key')
export const TrashIcon = make('trash')
