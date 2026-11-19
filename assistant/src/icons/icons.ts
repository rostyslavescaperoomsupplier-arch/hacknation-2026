// Icon subset from the Filharmonia icon set (24x24, 1.5 stroke, currentColor).
export interface IconDef { d: string[]; fill?: string[] }
const DEFS = {
 "spark-solid": {
  "d": [],
  "fill": [
   "M12 2.5 13.9 10.1 21.5 12 13.9 13.9 12 21.5 10.1 13.9 2.5 12 10.1 10.1Z"
  ]
 },
 "arrow-right": {
  "d": [
   "M4 12h15",
   "M13.5 6.5 19 12l-5.5 5.5"
  ]
 },
 "phone": {
  "d": [
   "M5 3.5h4l1.5 4.5-2.5 2 6 6 2-2.5 4.5 1.5v4l-2 1.5h-2L3.5 7.5v-2Z"
  ]
 },
 "external": {
  "d": [
   "M13.5 4.5h6v6",
   "M19.5 4.5l-8.5 8.5",
   "M17 14v5.5H4.5V7H10"
  ]
 },
 "stop": {
  "d": [
   "M6 6h12v12H6Z"
  ]
 },
 "mic": {
  "d": [
   "M9 5.5 10.5 3.5h3L15 5.5v6l-1.5 2h-3L9 11.5Z",
   "M6 10v2.5L8.5 16h7l2.5-3.5V10",
   "M12 16v4.5",
   "M8.5 20.5h7"
  ]
 },
 "volume": {
  "d": [
   "M3.5 9.5h4l5-5v15l-5-5h-4Z",
   "M15.5 9l1.5 3-1.5 3",
   "M18 6.5l2.5 5.5-2.5 5.5"
  ]
 },
 "chevron-right": {
  "d": [
   "M9.5 7.5 15 12l-5.5 4.5"
  ]
 },
 "chevron-down": {
  "d": [
   "M7.5 9.5 12 15l4.5-5.5"
  ]
 }
} satisfies Record<string, IconDef>;
export type IconName = keyof typeof DEFS;
export const ICONS: Record<IconName, IconDef> = DEFS;
