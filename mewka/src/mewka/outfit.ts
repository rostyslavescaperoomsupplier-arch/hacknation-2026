// Outfit type kept for API compatibility (setOutfit). The GLB bird does not model clothes, so it is a no-op.
export type Slot = 'head' | 'neck' | 'eyes' | 'body' | 'hand';
export type ItemId = string;
export type Outfit = Partial<Record<Slot, ItemId>>;
