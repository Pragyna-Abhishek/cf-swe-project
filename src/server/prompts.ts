// Prompt templates, bundled as text by the Wrangler "Text" module rule for prompts/*.txt.

import classifySymptomSystem from "../../prompts/classify-symptom.system.txt";
import classifySymptomUser from "../../prompts/classify-symptom.user.txt";
import draftRuleSystem from "../../prompts/draft-rule.system.txt";
import draftRuleUser from "../../prompts/draft-rule.user.txt";
import hypothesizeSystem from "../../prompts/hypothesize.system.txt";
import hypothesizeUser from "../../prompts/hypothesize.user.txt";
import writeReportSystem from "../../prompts/write-report.system.txt";
import writeReportUser from "../../prompts/write-report.user.txt";
import type { PromptTemplates } from "../core/prompt";

export const DRAFT_RULE_TEMPLATES: PromptTemplates = { system: draftRuleSystem, user: draftRuleUser };
export const CLASSIFY_SYMPTOM_TEMPLATES: PromptTemplates = { system: classifySymptomSystem, user: classifySymptomUser };
export const HYPOTHESIZE_TEMPLATES: PromptTemplates = { system: hypothesizeSystem, user: hypothesizeUser };
export const WRITE_REPORT_TEMPLATES: PromptTemplates = { system: writeReportSystem, user: writeReportUser };
