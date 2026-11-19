import { createHash } from 'node:crypto';
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TESTDATADIR = "./test_data_in";
const TESTDATAOUTDIR = "./test_data_out";

const CLASSIFICATION = false;
const CLASSIFICATION_BASEURL = "https://api.typesafe.ai/v1/systemone"
const CLASSIFICATION_BEARER = "apikey_xyz"
const CLASSIFICATION_LIMIT = 30000;
const CLASSIFICATION_JSON = {
  "state": { "prompt": "${PROMPT}" },
  "model": "jev-latest",
  "questions": {
    "prompt_category": {
      "type": "choice",
      "instructions": "In which category is the prompt ?",
      "criteria": {
        "translation": "translating text from one human language to another: “Translate this from German to English.”",
        "math": "arithmetic, algebra, calculus, geometry, probability, statistics, mathematical proofs, etc.",
        "trivia": "factual/general-knowledge questions: ”Who won the 1954 World Cup?”",
        "programming": "writing/debugging/explaining code, APIs, algorithms.",
        "technicalSupport": "Linux, SSH, networking, configuration, error messages, hardware, etc.",
        "research": "questions requiring gathering/combining information rather than retrieving one known fact.",
        "currentInformation": "inherently time-sensitive questions such as “What’s the latest Ubuntu version?”",
        "reasoning": "logic, deduction, planning, analysis, puzzles, and problems requiring multi-step reasoning.",
        "writing": "emails, reports, rewriting, grammar/style.",
        "summarization": "summarizing supplied content.",
        "dataAnalysis": "interpreting tables, CSVs, statistics, logs, etc.",
        "recommendation": "Which X should I choose?",
        "creative": "stories, brainstorming, names, poems, etc.",
        "other": "important as a fallback instead of forcing a bad classification."
      }
    },
    "prompt_complexity": {
      "type": "score",
      "instructions": "How complex is it to answer the prompt ?",
      "criteria": [
        "Easy: Even a small local open weight model can answer it correctly.",
        "Medium: A sophisticated model (>=300B) can handle the prompt.",
        "Hard: Only the latest and best frontier foundation model from anthropic or open ai can handle it."
      ]
    },
    "sensitiveData": {
      "type": "noul",
      "instructions": "Estimates the probability that the prompt itself contains sensitive, confidential, private, secret, or security-relevant information."
    }
  }
};

/* 4 Scripts */
async function prompt(input, input_type, limit, context) {
  return JSON.stringify(input.messages);
}

async function evaluate(input, input_type, classification, models, context) { 
  return { category: "unknown", sensitiveData: false, complexity: 0, models: null }
}

async function updateInput(input, input_type, context) {  
  return input;
}

async function updateOutput(output, output_type, context) {
  return output;
}

/* Internal helper functions */
async function readJsonFile(filePath) {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch {
    return null;
  }
}

async function readDirectory(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.name !== '.DS_Store')
    .map((entry) => ({
      name: entry.name,
      path: join(dirPath, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
}

async function fetchJson(object, apiUrl, bearerToken) {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(object),
  });

  const text = await response.text();

  let result;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON response from ${apiUrl}`);
  }

  if (!response.ok) {
    const message = result?.message || result?.error || "Request failed";
    const error = new Error(message);
    error.status = response.status;
    error.response = result;
    throw error;
  }

  return result;
}

async function clearOrCreateDirectory(dirPath) {
  try {
    const entries = await readdir(dirPath);

    await Promise.all(
      entries.map((entry) =>
        rm(join(dirPath, entry), {
          recursive: true,
          force: true,
        })
      )
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      await mkdir(dirPath, { recursive: true });
    } else {
      throw error;
    }
  }
}

async function writeFileData(path, data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 4);
  await writeFile(path, content, { encoding: 'utf8' });
}

async function logDebug(fileName, text) {
  let path = join(this.path, fileName);
  writeFileData(path, text);
}

const cache = {};

async function readStringCache(key) {
  let ret = null;
  try {
    ret = cache[key] || null;
  } catch (error) {
  }
  return ret;
}

async function writeStringCache(key, value) {
  let ret = false;
  try {
    cache[key] = value;
    ret = true;
  } catch (error) {

  }
  return ret;
}

function generateMd5(text) {
  return createHash('md5').update(text).digest('hex');
}

const testDirs = await readDirectory(TESTDATADIR);

clearOrCreateDirectory(TESTDATAOUTDIR);

for (let di = 0; di < testDirs.length; di++) {
  const dir = testDirs[di];
  if (dir.isDirectory) {
    let inp = await readJsonFile(dir.path + "/input.json");
    let meta = await readJsonFile(dir.path + "/metadata.json");
    let outp = await readJsonFile(dir.path + "/original_output.json");

    if (inp !== null && meta !== null && outp !== null) {
      let inp_type = meta.endpoint === "/v1/chat/completions" ? "OPENAI" : meta.endpoint === "/v1/responses" ? "OPENAI_RESPONSES" : "ANTHROPIC";
      console.log(`Test ${dir.name} ${di + 1}:${testDirs.length}`)
      try {
        let outDirPath = `${TESTDATAOUTDIR}/${dir.name}`;
        let context = {
          user_id: meta.user_id,
          role_id: meta.role_id,
          request_id: meta.request_id,
          md5: generateMd5,
          logDebug: logDebug.bind({ path: outDirPath }),
          readStringCache,
          writeStringCache,
          fetchJson
        }

        await mkdir(outDirPath, { recursive: true });

        await writeFileData(`${outDirPath}/input.json`, inp);
        await writeFileData(`${outDirPath}/metadata.json`, meta);
        await writeFileData(`${outDirPath}/original_output.json`, outp);

        if (CLASSIFICATION) {
          let pt = await prompt(inp, inp_type, CLASSIFICATION_LIMIT, context);
          let json = JSON.parse(JSON.stringify(CLASSIFICATION_JSON).replaceAll('"${PROMPT}"', pt));
          let evalIn = await fetchJson(json, CLASSIFICATION_BASEURL, CLASSIFICATION_BEARER);
          let evalOut = await evaluate(inp, inp_type, evalIn, [], context);
          await writeFileData(`${outDirPath}/prompt.txt`, pt);
          await writeFileData(`${outDirPath}/evaluate_in.json`, evalIn);
          await writeFileData(`${outDirPath}/evaluate_out.json`, evalOut);
        }
        inp = await updateInput(inp, inp_type, context);
        await writeFileData(`${outDirPath}/updateInput.json`, inp);

        for (let oi = 0; oi < outp.length; oi++) {
          let o = outp[oi];
          try {
            await updateOutput(o, inp_type, context);
          } catch (error) {
            console.error(error);
          }
        }
      } catch (error) {
        console.error(error);
      }
    }
  }
}
