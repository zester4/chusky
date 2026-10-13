import { readFile } from "node:fs/promises";
import { DEFAULT_VOICE_EVALUATION_SCENARIOS, scoreVoiceTrace, type VoiceEvaluationTrace } from "../src/calls/voiceEvaluation.js";

const fixturePath = process.argv.slice(2).find((value) => value !== "--fixture");
if (!fixturePath) {
  console.log(JSON.stringify({ scenarios: DEFAULT_VOICE_EVALUATION_SCENARIOS.map(({ id, direction, purpose }) => ({ id, direction, purpose })) }, null, 2));
  process.exit(0);
}

const payload = JSON.parse(await readFile(fixturePath, "utf8")) as { scenarioId?: string; trace?: VoiceEvaluationTrace };
const scenario = DEFAULT_VOICE_EVALUATION_SCENARIOS.find((candidate) => candidate.id === payload.scenarioId);
if (!scenario || !payload.trace) throw new Error("Fixture must contain a valid scenarioId and trace");
console.log(JSON.stringify(scoreVoiceTrace(payload.trace, scenario), null, 2));
