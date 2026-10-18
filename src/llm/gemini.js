// Gemini through @google/genai, behind a small provider-neutral interface:
//   generate({ system, messages, tools, jsonSchema }) -> { text, calls: [{ name, args }] }
// messages: { role: "user", text } | { role: "model", text?, calls? } | { role: "tool", results: [{ name, response }] }
import { GoogleGenAI } from "@google/genai";

function toContents(messages) {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
    if (m.role === "model") {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.calls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      return { role: "model", parts };
    }
    return {
      role: "user",
      parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { output: r.response } } })),
    };
  });
}

export class GeminiLLM {
  constructor({ apiKey, model = "gemini-2.5-flash" }) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async generate({ system, messages, tools, jsonSchema, temperature = 0.4 }) {
    const config = { systemInstruction: system, temperature };
    if (tools?.length) {
      config.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.inputSchema,
          })),
        },
      ];
    }
    if (jsonSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = jsonSchema;
    }
    const res = await this.ai.models.generateContent({ model: this.model, contents: toContents(messages), config });
    return {
      text: res.text ?? "",
      calls: (res.functionCalls ?? []).map((c) => ({ name: c.name, args: c.args ?? {} })),
    };
  }
}
