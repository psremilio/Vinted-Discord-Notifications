# AGENTS

## Migration Task
Use docs in /tmp/tmp.HZJwymtLPJ; migrate OpenAI completions→responses using model gpt-5.

- Do not preserve backward compatibility wrappers; adopt the Responses output shape across the codebase.
- Do not leave tombstone comments or backup files in the repo.
- If migrating to gpt-5, ensure 'temperature' is omitted or set to 1 to avoid errors.
