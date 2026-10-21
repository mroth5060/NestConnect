import { describe, expect, it } from "vitest";
import {
  resolveTemplateDefault,
  TEMPLATE_TOKENS,
  templateDefaults,
  type TemplateFillContext,
} from "@ding/schemas";

/**
 * What a template's variables start out as when somebody sends it.
 *
 * The whole point is that nobody retypes their own name into every send, so the
 * failures worth guarding are the ones that reach a customer looking like a
 * mistake: a literal "{{contact.name}}" in a message, the word "undefined"
 * where a company should be, or a token silently blanking a sentence.
 */

const CTX: TemplateFillContext = {
  contactName: "Marta Kowalska",
  contactCompany: "Northside Logistics",
  contactPhone: "+44 7700 900123",
  contactEmail: "marta@example.com",
  agentName: "Nathan A",
  channelName: "Hermolis Support",
};

describe("resolving one default", () => {
  it("puts a value where a token was", () => {
    expect(resolveTemplateDefault("{{contact.name}}", CTX)).toBe("Marta Kowalska");
  });

  it("takes a first name off a full one", () => {
    expect(resolveTemplateDefault("{{contact.first_name}}", CTX)).toBe("Marta");
    expect(resolveTemplateDefault("{{agent.first_name}}", CTX)).toBe("Nathan");
  });

  it("mixes text and tokens, which is why there's no type to choose", () => {
    expect(resolveTemplateDefault("Hi from {{agent.first_name}} at Hermolis", CTX)).toBe(
      "Hi from Nathan at Hermolis",
    );
  });

  it("leaves plain text alone", () => {
    expect(resolveTemplateDefault("Order update", CTX)).toBe("Order update");
  });

  it("has something for every token the menu offers", () => {
    // A token in the menu that resolves to itself would be a dead entry an
    // admin could pick and never notice until a customer got the raw text.
    for (const { token } of TEMPLATE_TOKENS) {
      const out = resolveTemplateDefault(`{{${token}}}`, CTX);
      expect(out, token).not.toBe(`{{${token}}}`);
      expect(out.length, token).toBeGreaterThan(0);
    }
  });

  it("is not fussy about spacing or case", () => {
    expect(resolveTemplateDefault("{{ Contact.Name }}", CTX)).toBe("Marta Kowalska");
  });
});

describe("when a fact is missing", () => {
  it("resolves a known token to nothing rather than the word undefined", () => {
    // A contact with no company on file must not be greeted "Hi undefined".
    expect(resolveTemplateDefault("{{contact.company}}", { contactName: "Sam" })).toBe("");
  });

  it("and an empty context leaves an empty box, not a broken sentence", () => {
    expect(resolveTemplateDefault("{{contact.name}}", {})).toBe("");
  });
});

describe("when somebody mistypes a token", () => {
  it("leaves it visible instead of blanking it", () => {
    // Silently emptying it would send a half-finished sentence with nothing to
    // show what went wrong. Left as written, the mistake is in the box where
    // the person who made it can see it.
    expect(resolveTemplateDefault("Hi {{contact.frist_name}}", CTX)).toBe("Hi {{contact.frist_name}}");
  });

  it("and a WhatsApp variable is not mistaken for one of ours", () => {
    expect(resolveTemplateDefault("{{1}}", CTX)).toBe("{{1}}");
  });
});

describe("the form's starting values", () => {
  const tpl = (variableCount: number, variableDefaults: string[] = []) => ({
    variableCount,
    variableDefaults,
  });

  it("gives a box per variable whether or not a default was saved", () => {
    expect(templateDefaults(tpl(3, ["{{contact.first_name}}"]), CTX)).toEqual(["Marta", "", ""]);
  });

  it("is all blanks when nothing was saved", () => {
    expect(templateDefaults(tpl(2), CTX)).toEqual(["", ""]);
  });

  it("ignores defaults past the body's variable count", () => {
    // A template edited down from three variables to one must not carry the
    // stranded third into the form.
    expect(templateDefaults(tpl(1, ["a", "b", "c"]), CTX)).toEqual(["a"]);
  });

  it("keeps position when an earlier default is blank", () => {
    expect(templateDefaults(tpl(3, ["", "{{contact.company}}", ""]), CTX)).toEqual([
      "",
      "Northside Logistics",
      "",
    ]);
  });
});
