// Small inline icons for the call UI (24x24, 1.75 stroke, currentColor), drawn in the style of src/icons.
// No icon library (CONTRACT.md).
const PATHS = {
  phone: ['M5 3.5h4l1.5 4.5-2.5 2 6 6 2-2.5 4.5 1.5v4l-2 1.5h-2L3.5 7.5v-2Z'],
  hangup: ['M2.5 13.5v-2.5C5 8.5 8.5 7.5 12 7.5s7 1 9.5 3.5v2.5l-4 1-1.5-3c-2.5-1-5.5-1-8 0l-1.5 3Z'],
  camera: ['M3 7.5h12v9H3Z', 'M15 10.5l6-3v9l-6-3'],
  'camera-off': ['M3 7.5h12v9H3Z', 'M15 10.5l6-3v9l-6-3', 'M3 3.5l18 17'],
  mic: ['M9 5.5 10.5 3.5h3L15 5.5v6l-1.5 2h-3L9 11.5Z', 'M6 10v2.5L8.5 16h7l2.5-3.5V10', 'M12 16v4.5', 'M8.5 20.5h7'],
  'mic-off': ['M9 5.5 10.5 3.5h3L15 5.5v6l-1.5 2h-3L9 11.5Z', 'M6 10v2.5L8.5 16h7l2.5-3.5V10', 'M12 16v4.5', 'M8.5 20.5h7', 'M3.5 3.5l17 17'],
  terminal: ['M3.5 4.5h17v11h-17Z', 'M9 19.5h6', 'M12 15.5v4', 'M7 8.5l2.5 2-2.5 2', 'M11.5 12.5h4'],
  wave: ['M3 12h2', 'M7 8v8', 'M11 5v14', 'M15 8v8', 'M19 10.5v3'],
} satisfies Record<string, string[]>;

export type CallIconName = keyof typeof PATHS;

export function CallIcon({ name, size = 20 }: { name: CallIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
      {PATHS[name].map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
