export type CatalogItem = { id: string; price: number; free: boolean };

export const CATALOG: CatalogItem[] = [
  { id: "garden", price: 0, free: true },
  { id: "midnight", price: 0, free: true },
  { id: "marigold", price: 0, free: true },
  { id: "confetti", price: 0, free: true },
  { id: "table", price: 0, free: true },
  { id: "banquet", price: 0, free: true },
  { id: "lantern", price: 0, free: true },
  { id: "spark", price: 0, free: true },
  { id: "years", price: 0, free: true },
  { id: "promise", price: 0, free: true },
  { id: "hearth", price: 0, free: true },
];

export function findTemplate(id: string) {
  return CATALOG.find((item) => item.id === id);
}
