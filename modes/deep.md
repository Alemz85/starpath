# Modo: deep — Deep Research Prompt

## Company Research Cache

Before running any WebSearch for company intelligence, check the cache:

1. Compute the slug: `{company-name}` → lowercase, hyphens instead of spaces (e.g., `trade-republic`)
2. Check if `data/companies/{slug}.md` exists
3. Read the `<!-- cached: YYYY-MM-DD -->` header
4. If the cache is **less than 30 days old** → use the cached version, skip all WebSearch calls, and note to the user: *"(Research from cached data — {cached date})"*
5. If the cache is **30+ days old or missing** → run the full research below, then save to `data/companies/{slug}.md`

**Cache file format:**
```markdown
<!-- cached: YYYY-MM-DD -->
<!-- company: {Company Name} -->

## Deep Research: {Company} — {Role}

{full research output below}
```

After saving, note to the user: *"(Research cached to data/companies/{slug}.md — will reuse for 30 days)"*

---

Genera un prompt estructurado para Perplexity/Claude/ChatGPT con 6 ejes:

```
## Deep Research: [Empresa] — [Rol]

Contexto: Estoy evaluando una candidatura para [rol] en [empresa]. Necesito información accionable para la entrevista.

### 1. Estrategia AI
- ¿Qué productos/features usan AI/ML?
- ¿Cuál es su stack de AI? (modelos, infra, tools)
- ¿Tienen blog de engineering? ¿Qué publican?
- ¿Qué papers o talks han dado sobre AI?

### 2. Movimientos recientes (últimos 6 meses)
- ¿Contrataciones relevantes en AI/ML/product?
- ¿Acquisitions o partnerships?
- ¿Product launches o pivots?
- ¿Rondas de funding o cambios de liderazgo?

### 3. Cultura de engineering
- ¿Cómo shipean? (cadencia de deploy, CI/CD)
- ¿Mono-repo o multi-repo?
- ¿Qué lenguajes/frameworks usan?
- ¿Remote-first o office-first?
- ¿Glassdoor/Blind reviews sobre eng culture?

### 4. Retos probables
- ¿Qué problemas de scaling tienen?
- ¿Reliability, cost, latency challenges?
- ¿Están migrando algo? (infra, models, platforms)
- ¿Qué pain points menciona la gente en reviews?

### 5. Competidores y diferenciación
- ¿Quiénes son sus main competitors?
- ¿Cuál es su moat/diferenciador?
- ¿Cómo se posicionan vs competencia?

### 6. Ángulo del candidato
Dado mi perfil (read from cv.md and profile.yml for specific experience):
- ¿Qué valor único aporto a este equipo?
- ¿Qué proyectos míos son más relevantes?
- ¿Qué historia debería contar en la entrevista?
```

Personalizar cada sección con el contexto específico de la oferta evaluada.
