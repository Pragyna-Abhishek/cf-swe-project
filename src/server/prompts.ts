// Prompt templates, bundled as text by the Wrangler "Text" module rule for prompts/*.txt.

import draftRuleSystem from "../../prompts/draft-rule.system.txt";
import draftRuleUser from "../../prompts/draft-rule.user.txt";
import type { PromptTemplates } from "../core/prompt";

export const DRAFT_RULE_TEMPLATES: PromptTemplates = { system: draftRuleSystem, user: draftRuleUser };
