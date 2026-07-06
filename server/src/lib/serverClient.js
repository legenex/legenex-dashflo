import { entitiesNamespace, repo } from '../db/repo.js';
import { invokeLLM } from '../integrations/llm.js';
import { extractDataFromFile } from '../integrations/extract.js';
import { sendMail } from './mailer.js';

// The object passed into ported backend functions. It mirrors the shape the
// original serverless functions were written against:
//   const db = createServerClient(user)
//   db.entities.Lead.filter(...)
//   db.auth.me()
//   db.integrations.Core.InvokeLLM(...)
export function createServerClient(user = null) {
  const entities = entitiesNamespace();
  return {
    entities,
    auth: {
      me: async () => user,
      updateMe: async (patch) => {
        if (!user) throw new Error('Not authenticated');
        return repo('User').update(user.id, patch);
      },
    },
    integrations: {
      Core: {
        InvokeLLM: (args) => invokeLLM(args),
        ExtractDataFromUploadedFile: (args) => extractDataFromFile(args),
        SendEmail: ({ to, subject, body, html } = {}) => sendMail({ to, subject, text: body, html }),
      },
    },
  };
}

export { repo as entityRepo };
export default createServerClient;
