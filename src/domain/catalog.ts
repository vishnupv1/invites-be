export type CatalogItem = { id: string; price: number; free: boolean };

export const CATALOG: CatalogItem[] = [
  { id: "garden", price: 0, free: true },
  { id: "midnight", price: 29, free: false },
  { id: "marigold", price: 39, free: false },
  { id: "confetti", price: 19, free: false },
  { id: "table", price: 24, free: false },
  { id: "banquet", price: 29, free: false },
  { id: "lantern", price: 34, free: false },
  { id: "spark", price: 19, free: false },
  { id: "years", price: 24, free: false },
  { id: "promise", price: 22, free: false },
  { id: "hearth", price: 18, free: false },
];

export function findTemplate(id: string) {
  return CATALOG.find((item) => item.id === id);
}
