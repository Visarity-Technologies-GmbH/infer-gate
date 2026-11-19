/**
All reasoning (string length > 512) will be compacted by calling a llm.
 
Input:
  * input - Original input of /v1/messages, /v1/chat/completions or /v1/responses
  * input_type - "ANTHROPIC", "OPENAI", or "OPENAI_RESPONSES"
  * context - Request-local object shared with prompt, updateInput and updateOutput

Output: 
  returns updated input

Disclaimer:
  SIMPLIFIED DEMO CODE - Only tested for /v1/chat/completions
*/


async function updateInput(input, input_type, context) {
  let ret = input;

  async function replaceThinkBlocks(text, callback) {
    const pattern = /<think>([\s\S]*?)<\/think>/g;
    let result = "";
    let lastIndex = 0;

    for (const match of text.matchAll(pattern)) {
      result += text.slice(lastIndex, match.index);
      let t = await callback(match[1]);
      result += `<think>${t}</think>`;
      lastIndex = match.index + match[0].length;
    }

    return result + text.slice(lastIndex);
  }

  async function transformReasoning(input, callback) {
    const data = JSON.parse(JSON.stringify(input));

    async function visit(value) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          value[i] = await visit(value[i]);
        }
        return value;
      }

      if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
          const child = value[key];

          // Common structured reasoning fields used by providers.
          if (
            typeof child === "string" &&
            ["reasoning", "reasoning_content", "thinking"].includes(key)
          ) {
            value[key] = await callback(child);
            continue;
          }

          value[key] = await visit(child);
        }
        return value;
      }

      if (typeof value === "string") {
        return replaceThinkBlocks(value, callback);
      }

      return value;
    }

    return visit(data);
  }

  if (input_type === "OPENAI") {
    try {
      ret = await transformReasoning(input, async (reasoning) => {
        let ret = reasoning || "";
        if (reasoning && reasoning.length > 512) {
          let k = context.md5(reasoning);
          let v = await context.readStringCache(k);
          if (v === null) {
            let apiInput = {
              "model": "qwen/qwen3.5-9b",
              "stream": false,
              "chat_template_kwargs": { "enable_thinking": false },
              "messages": [
                {
                  "role": "system",
                  "content": "You summarize reasoning text so the summary can replace the original reasoning. Rewrite the input as a moderately shorter, self-contained version. Preserve its intent, conclusions, constraints, key decisions, and concrete implementation details needed to understand or carry out the work. Remove repetition, filler, and unnecessary wording. Do not add assumptions, recommendations, or facts that are not in the input, and do not omit important details just to make the summary shorter. Return only the rewritten reasoning, with no heading, preamble, or commentary. Return a plain text. "
                },
                {
                  "role": "user",
                  "content": `<text>${reasoning}</text>`
                }
              ],
              "temperature": 0.7,
              "max_tokens": 32000
            };

            try {
              let t = await context.fetchJson(apiInput, "http://localhost:3000/v1/chat/completions", "pak_dUgZ00tLi2vO8feWDpt-dTrmaqQ02dW2itqD7yNqaWY");
              let a = t.choices[0].message.content;
              await context.writeStringCache(k, a);
              ret = a;
            } catch (error) {
            }
          } else {
            ret = v;
          }
        }
        return ret;
      })
    } catch (error) {

    }
  }

  return ret;
}