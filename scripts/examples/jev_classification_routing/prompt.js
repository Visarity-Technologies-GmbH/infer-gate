/**
Returns system prompt and the last use / assistant content
 
Input:
  * input - Original input of /v1/messages, /v1/chat/completions or /v1/responses
  * input_type - "ANTHROPIC", "OPENAI", or "OPENAI_RESPONSES"
  * context - Request-local object shared with prompt, updateInput and updateOutput

Output: 
  returns a string (used for the classification)

Disclaimer:
  SIMPLIFIED DEMO CODE - Only works for /v1/chat/completions, ignores limit
*/

async function prompt(input, input_type, limit, context) {
  function splitByRole(messages) {
    const result = {
      system: [],
      other: []
    };

    for (const message of messages) {
      const { role, content } = message;

      if (!["system", "assistant", "user"].includes(role)) {
        continue;
      }

      const cleanedContent =
        typeof content === "string"
          ? content.replace(/.*<\/think>/s, "")
          : content;

      let r = role !== "system" ? "other" : "system"
      result[r].push({
        role,
        content: cleanedContent
      });
    }

    return result;
  }
  let t = splitByRole(input.messages);
  let r = [];
  r[0] = t.system[0];
  let s = t.other.length - 4;

  for (let i = s < 0 ? 0 : s; i < t.other.length; i++) {
    r.push(t.other[i]);
  }

  return JSON.stringify(r);
}