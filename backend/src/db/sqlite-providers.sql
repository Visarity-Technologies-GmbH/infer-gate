INSERT INTO llm_inference_providers (name, api_url, api_type, status) VALUES
  ('OpenAI', 'https://api.openai.com/v1', 'OPENAI_COMPATIBLE', 'ACTIVE'),
  ('Anthropic', 'https://api.anthropic.com/v1', 'ANTHROPIC', 'ACTIVE'),
  ('Gemini', 'https://generativelanguage.googleapis.com/v1beta', 'GEMINI', 'ACTIVE'),
  ('AWS Bedrock', 'https://bedrock-mantle.{region}.api.aws/v1', 'AWS_BEDROCK', 'ACTIVE');
