import { config } from "../config.js";

const CATALOG = [
  { id: "pastal", name: "Pastal party", occasion: "wedding", about: "Pressed-paper palace wedding opened by a wax seal" },
  { id: "grandenvelope", name: "Grand Envelope", occasion: "wedding", about: "Wax-seal envelope wedding" },
  { id: "grandoor", name: "The Grand Door", occasion: "wedding", about: "Palace doors opening onto a lake wedding" },
  { id: "shaadi", name: "Shaadi", occasion: "wedding", about: "Veil-lift palace shaadi with several functions" },
  { id: "pull", name: "Curtain Call", occasion: "wedding", about: "Velvet curtain pulled open for a wedding" },
  { id: "heavenly", name: "Enchanted Doors", occasion: "wedding", about: "Lantern-lit palace doors for a wedding" },
  { id: "vivah", name: "Vivah", occasion: "wedding", about: "Night-sky palace doors for a Hindu wedding" },
  { id: "aurelia", name: "Aurelia", occasion: "wedding", about: "Navy and gold wedding" },
  { id: "gazal", name: "Gazal", occasion: "nikah", about: "Emerald nikah and walima" },
  { id: "beach", name: "Sunset Shore", occasion: "wedding", about: "Beach wedding in a message bottle" },
  { id: "anna", name: "Anna", occasion: "wedding", about: "Cream garden wedding" },
  { id: "botanica", name: "Blush Botanica", occasion: "wedding", about: "Floral frames for a wedding or engagement" },
  { id: "thiruvizha", name: "Thiruvizha", occasion: "wedding", about: "Tamil wedding with kolam and nadaswaram" },
  { id: "peace", name: "Peace", occasion: "wedding", about: "Gift-hamper wedding" },
  { id: "inland", name: "Inland Letter", occasion: "birthday", about: "Tear-open letter for a birthday party" },
  { id: "baptism", name: "Little Blessing", occasion: "baptism", about: "Dove and sky baptism, naming, or baby blessing" },
  { id: "hearth", name: "Hearth", occasion: "housewarming", about: "Front door opening for a housewarming" },
] as const;

const IDS = new Set<string>(CATALOG.map((item) => item.id));

const SYSTEM = `You choose digital invitation templates for one sentence a host typed.
Templates:
${CATALOG.map((item) => `- ${item.id}: ${item.name}. ${item.occasion}. ${item.about}`).join("\n")}

Reply with JSON only: {"relevant": true or false, "ids": ["id"]}
relevant is true only when the sentence is about a real celebration: wedding, nikah, shaadi, engagement, reception, birthday, baptism, naming ceremony, baby shower, housewarming, griha pravesh, anniversary, or a similar gathering.
relevant is false for nonsense, chores, shopping, code, weather, news, insults, or anything that is not a celebration.
When relevant, return up to 3 ids from the list, best match first. Weddings and engagements use wedding templates. A nikah prefers gazal, then other weddings. A birthday prefers inland. A baptism, naming, or baby shower prefers baptism. A housewarming prefers hearth.
When not relevant, ids must be an empty array.`;

export async function suggestTemplates(query: string): Promise<{ relevant: boolean; ids: string[] }> {
  const key = config.openaiApiKey;
  if (!key) return { relevant: false, ids: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: query.slice(0, 400) },
        ],
      }),
    });
    if (!response.ok) return { relevant: false, ids: [] };
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = payload.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as { relevant?: unknown; ids?: unknown };
    const ids = Array.isArray(parsed.ids)
      ? [...new Set(parsed.ids.filter((id): id is string => typeof id === "string" && IDS.has(id)))].slice(0, 3)
      : [];
    if (parsed.relevant !== true || !ids.length) return { relevant: false, ids: [] };
    return { relevant: true, ids };
  } catch {
    return { relevant: false, ids: [] };
  } finally {
    clearTimeout(timer);
  }
}
