/**
Input:
  * input - Original input of /v1/messages, /v1/chat/completions or /v1/responses
  * input_type - "ANTHROPIC", "OPENAI", or "OPENAI_RESPONSES"
  * classification - Output of the classification API call
  * models - Array of available models (just the IDs of the models)
  * context - Request-local object shared with prompt, updateInput and updateOutput

Output:
  * Promise resolving to a json object {
    category: "",         //String
    sensitiveData: true,  //Boolean true or false
    complexity: 0, //0-easy, 1-medium, 2-hard (better handled by a foundation model)
    models: ["qwen/qwen3.5-9b", ".."]           //String array of Model IDs or null
  }

Disclaimer:
  SIMPLIFIED DEMO CODE

*/

async function evaluate(input, input_type, classification, models_input, context) {
  let a = classification.answers;
  let category = a.prompt_category.confidence > 0.9 ? a.prompt_category.choice : "other";
  let sensitiveData = a.sensitiveData.noul > 0.9;
  let complexity = 2;
  let models = null;

  if (a.prompt_complexity.confidence > 0.70) {
    let p = a.prompt_complexity.probabilities;
    let p0 = p[0] * 0.8;
    let p1 = p[1] * 0.9;
    let p2 = p[2];
    complexity = (p2 > p1) && (p2 > p0) ? 2 : (p1 > p2) && (p1 > p0) ? 1 : 0;
  }

  //Model routing
  if (category === "translation" && complexity < 1) {
    models = ["qwen/qwen3.5-9b"];
  }

  return { category, sensitiveData, complexity, models }
}
