import { connectToBrowser, detachBrowser, selectTab } from "./connect.mjs";
import { fillApplication } from "./fill.mjs";

const MAX_ERROR_LENGTH = 320;

function answerSchema(z) {
  return z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.object({
      value: z.unknown().optional(),
      needs_confirmation: z.boolean().optional(),
      needsReview: z.boolean().optional(),
    }),
  ]);
}

function content(text) {
  return [{ type: "text", text }];
}

function toolResult(text, details) {
  return { content: content(text), details };
}

function publicField(field) {
  return {
    id: field.id,
    type: field.type,
    label: field.label,
    required: field.required,
    ...(field.options?.length ? { options: field.options } : {}),
    ...(field.maxLength ? { maxLength: field.maxLength } : {}),
    ...(field.value ? { value: field.value } : {}),
    ...(field.combobox ? { combobox: true } : {}),
    ...(field.nativeId ? { nativeId: field.nativeId } : {}),
    ...(field.nativeName ? { nativeName: field.nativeName } : {}),
  };
}

function assertNeverSubmitted(result) {
  if (!result || result.submitted !== false || result.verificationRequired !== true) {
    throw new Error("Jevfiller refused an unsafe result: submission protection was not confirmed");
  }
}

export default function jevfiller(pi) {
  const z = pi.zod;
  const answer = answerSchema(z);
  const answers = z.record(z.string(), answer);

  return [{
    name: "jevfiller",
    label: "Jevfiller",
    description: "Attach to an existing Playwright browser, fill the specified visible job application tab, verify the live values, and leave final submission to the human. Never launches or submits.",
    parameters: z.object({
      playwrightServerId: z.string().min(1),
      url: z.string().url(),
      tab: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
      answers,
    }),
    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      if (signal?.aborted) throw new Error("Jevfiller call was cancelled");
      const browser = await connectToBrowser(params.playwrightServerId);
      try {
        const selected = await selectTab(browser, params.tab ?? 0);
        const result = await fillApplication({
          page: selected.page,
          url: params.url,
          rawAnswers: params.answers,
          tabIndex: selected.index,
        });
        assertNeverSubmitted(result);
        return toolResult(
          `Filled ${result.appliedAnswers.length} answer(s) across ${result.pagesVisited} page(s). The existing tab is ready for human verification; submit manually if everything is correct.`,
          {
            tab: result.tab,
            fields: result.fields.map(publicField),
            appliedAnswers: result.appliedAnswers,
            steps: result.steps,
            pages: result.pages,
            pagesVisited: result.pagesVisited,
            issues: result.issues,
            navigated: result.navigated,
            verificationRequired: true,
            submitted: false,
            status: result.status,
            stoppedReason: result.stoppedReason,
            modelValidation: result.modelValidation,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "fill failed";
        throw new Error(`Jevfiller failed: ${message.slice(0, MAX_ERROR_LENGTH)}`);
      } finally {
        await detachBrowser(browser);
      }
    },
  }];
}
