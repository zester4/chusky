# Video design prompt references

These references synthesize current official guidance for video generation and practical commercial production patterns. They are a learning library, not templates to copy literally.

## Prompt method

Describe the subject, the exact action, the camera and lens behavior, the environment, lighting, visual style, timing or beat changes, sound, and delivery format. State what must remain consistent and what is allowed to move. For multi-shot work, repeat the same identity, wardrobe, product geometry, and palette in every shot.

For exact brand copy, prices, legal text, captions, or UI, generate clean footage first and add typography in post-production. Moving-video models can approximate text but should not be treated as a reliable typesetting system.

## Selective reading

- [Fashion editorial](fashion-editorial.md): runway, lookbook, beauty, and luxury campaigns.
- [Product advertising](product-ads.md): product hero films, launches, demonstrations, and performance ads.
- [UGC and social](ugc-social.md): creator-style ads, testimonials, hooks, and vertical short-form.
- [Cinematic storytelling](cinematic-storytelling.md): narrative scenes, atmosphere, and visual continuity.
- [Storyboards](storyboards.md): multi-shot commercial sequences and shot-by-shot planning.
- [Avatar and presenter](avatar-presenter.md): explainers, sales presenters, training, and spokesperson videos.
- [Action and specialty](action-and-specialty.md): chases, combat, long takes, macro miniature work, and transformation sequences.

## Model-aware routing

The runtime chooses among the approved live catalog: Seedance, Wan, Hailuo, FLUX Video, HeyGen, and Veo. Prompts should express the creative goal first; the router maps it to a model based on duration, audio, references, aspect ratio, and continuity requirements.

- Seedance: premium general work, 4K, character continuity, and first/last-frame control.
- Wan: longer narrative clips and evolving action.
- Hailuo: fast branded concepts, controlled edits, and text/detail experiments.
- FLUX Video: premium reference-led continuation and keyframe work.
- HeyGen: presenter, avatar, and creator-style speaking videos; never assume its live catalog supports audio.
- Veo: cinematic fidelity and synchronized audio when the live capability catalog confirms it.

## Originality and safety

Use these examples to learn structure, not to reproduce a reference campaign. Invent the identity, subjects, brand, wording, setting, choreography, and art direction. Do not request celebrity likenesses, copyrighted characters, existing logos, or a near-duplicate of a supplied image or video. For reference images, explicitly identify what should stay unchanged and what should animate.

## Sources consulted

- [OpenRouter video generation guide](https://openrouter.ai/docs/guides/overview/multimodal/video-generation) for asynchronous generation, image-to-video references, and capability-driven model selection.
- [Google Veo documentation](https://ai.google.dev/gemini-api/docs/video) for prompt structure, reference images, camera direction, and audio-aware generation.
- [OpenAI video generation guide](https://developers.openai.com/api/docs/guides/video-generation) for shot prompting, image references, asynchronous jobs, and workflow constraints.
- [OpenRouter video model catalog](https://openrouter.ai/models?input_modalities=image&output_modalities=video) for current model availability and live capability metadata.

Availability, pricing, duration, audio, and resolution change. The agent must use `CHUCK_LIST_VIDEO_MODELS` or the live catalog before promising a capability.
