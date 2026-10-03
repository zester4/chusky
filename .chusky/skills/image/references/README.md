# Image Prompt References

Read only the category relevant to the request. These are reusable prompt patterns, not rigid templates; adapt the subject, audience, brand, platform, and model capabilities.

## Prompt design principles

The examples synthesize recurring guidance from current official image-model documentation:

- [OpenAI Image Generation](https://developers.openai.com/api/docs/guides/image-generation)
- [Google Gemini Image Generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [OpenRouter Image Generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [OpenRouter live image model catalog](https://openrouter.ai/api/v1/images/models)
- [Midjourney prompting guide](https://docs.midjourney.com/hc/en-us/articles/32474263844205-Prompting-Images)

The common high-performing structure is:

`objective → subject → action → composition → environment → style/material → lighting/color → typography → constraints → output`

Good prompts are specific about the visual decision that matters. They do not pile up unrelated style adjectives, request unsupported controls, or rely on a negative-prompt field that the selected OpenRouter model may not accept.

These examples teach patterns; they are not templates to imitate literally.
Create a new subject, identity, brand, wording, dates, composition, and visual
asset for every user request. Preserve only broad art-direction principles or
the exact user-owned asset elements the user explicitly asks to edit.

For premium production assets, GPT Image 2 is a strong option when the request
needs high-fidelity generation or editing, many references, or several output
variants. For 4K-specific work, inspect the live catalog because FLUX.3 and
other models may expose the required resolution control instead.

## Category references

- [Fashion and fashion-brand campaigns](fashion.md)
- [Logos and brand identity](logos.md)
- [Flyers, posters, and event graphics](flyers-posters.md)
- [Advertising and product campaigns](advertising.md)
- [Social, editorial, and content graphics](social-editorial.md)
