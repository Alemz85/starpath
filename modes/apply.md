# Modo: apply — Asistente de Aplicación en Vivo

> **Autonomous-mode contract.** When this mode is spawned non-interactively — `claude -p`, the starpath frontend's `shell:spawn` (e.g., the Database popover's "Draft Application" button), a batch worker, or any context where no human is in the loop to reply — follow these rules. (For interactive `claude` runs from a terminal where the candidate is at the keyboard, ask normally — this mode is conversational by design.)
>
> - **Don't ask the user any questions.** Not "want me to continue?", not "should I also do X?", not "want me to run the update next?". Draft answers using everything in the report + CV + profile, write them to disk for the user to review later, and finish.
> - **Don't propose follow-up actions** at the end. Print a one-line completion summary (rows added, files written, exit code) and stop.
> - **Don't run side-checks** like update polls, "first message of session" hooks, or unrelated diagnostics — they prompt for a reply nobody can give.
> - If you genuinely cannot proceed without input — corrupted file, missing config, ambiguous instruction — write the blocker to stderr and exit non-zero so the spawn surfaces as a failed task. Don't loiter waiting.

Modo interactivo para cuando el candidato está rellenando un formulario de aplicación en Chrome. Lee lo que hay en pantalla, carga el contexto previo de la oferta, y genera respuestas personalizadas para cada pregunta del formulario.

## Requisitos

- **Mejor con Playwright visible**: En modo visible, el candidato ve el navegador y Claude puede interactuar con la página.
- **Sin Playwright**: el candidato comparte un screenshot o pega las preguntas manualmente.

## Workflow

```
1. DETECTAR    → Leer Chrome tab activa (screenshot/URL/título)
2. IDENTIFICAR → Extraer empresa + rol de la página
3. BUSCAR      → Match contra reports existentes en reports/
4. CARGAR      → Leer report completo + Section G (si existe)
5. COMPARAR    → ¿El rol en pantalla coincide con el evaluado? Si cambió → avisar
6. ANALIZAR    → Identificar TODAS las preguntas del formulario visibles
7. GENERAR     → Para cada pregunta, generar respuesta personalizada
8. PRESENTAR   → Mostrar respuestas formateadas para copy-paste
```

## Paso 1 — Detectar la oferta

**Con Playwright:** Tomar snapshot de la página activa. Leer título, URL, y contenido visible.

**Sin Playwright:** Pedir al candidato que:
- Comparta un screenshot del formulario (Read tool lee imágenes)
- O pegue las preguntas del formulario como texto
- O diga empresa + rol para que lo busquemos

## Paso 2 — Identificar y buscar contexto

1. Extraer nombre de empresa y título del rol de la página
2. Buscar en `reports/` por nombre de empresa (Grep case-insensitive)
3. Si hay match → cargar el report completo
4. Si hay un `interview-prep/{Company} - {Role}.md` → cargarlo también (contexto STAR + draft answers previos)
5. Si NO hay match → avisar y ofrecer ejecutar `/career-ops scouting` para evaluar primero
6. **Leer `interview-prep/story-bank.md`** si existe — las historias STAR+R del banco son la fuente preferida para respuestas de formulario. Usar historias existentes antes de generar respuestas desde cero.

## Paso 3 — Detectar cambios en el rol

Si el rol en pantalla difiere del evaluado:
- **Avisar al candidato**: "El rol ha cambiado de [X] a [Y]. ¿Quieres que re-evalúe o adapto las respuestas al nuevo título?"
- **Si adaptar**: Ajustar las respuestas al nuevo rol sin re-evaluar
- **Si re-evaluar**: Ejecutar evaluación A-F completa, actualizar report, regenerar Section G
- **Actualizar tracker**: Cambiar título del rol en applications.md si procede

## Paso 4 — Analizar preguntas del formulario

Identificar TODAS las preguntas visibles:
- Campos de texto libre (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Campos de salario (range, expectation)
- Upload fields (resume, cover letter PDF)

Clasificar cada pregunta:
- **Ya cubierta por una historia del story-bank o por el interview-prep file** → adaptar el material existente
- **Nueva pregunta** → generar respuesta desde el report + cv.md

## Paso 5 — Generar respuestas

Para cada pregunta, generar la respuesta siguiendo:

1. **Story bank primero**: Para preguntas de tipo "Tell me about a time..." o "Give an example...", buscar en `interview-prep/story-bank.md` una historia STAR+R que encaje. Referenciar el título de la historia y adaptar el opening al contexto de la pregunta.
2. **Contexto del report**: Usar la sección "Gaps and opportunities" para anticipar follow-ups y los proof points implícitos en la dimensional table.
3. **Interview-prep file previo**: Si existe `interview-prep/{Company} - {Role}.md`, reusar las respuestas/intel ya generadas y refinar.
4. **Tono "I'm choosing you"**: posture confiada, específica, sin fluff. (Ver "Tone for Form Answers" abajo.)
5. **Especificidad**: Referenciar algo concreto del JD visible en pantalla.

**Formato de output:**

```
## Respuestas para [Empresa] — [Rol]

Basado en: Report #NNN | Score: X.X/10 | Arquetipo: [tipo]

---

### 1. [Pregunta exacta del formulario]
> [Respuesta lista para copy-paste]

### 2. [Siguiente pregunta]
> [Respuesta]

...

---

Notas:
- [Cualquier observación sobre el rol, cambios, etc.]
- [Sugerencias de personalización que el candidato debería revisar]
```

## Paso 6 — Post-apply (opcional)

Si el candidato confirma que envió la aplicación:
1. Actualizar estado en `applications.md` de "Evaluated" a "Applied"
2. Actualizar `interview-prep/{Company} - {Role}.md` con las respuestas finales (append a una sección `## Final form answers`)
3. Sugerir siguiente paso: `/career-ops contacto` para LinkedIn outreach

## Scroll handling

Si el formulario tiene más preguntas que las visibles:
- Pedir al candidato que haga scroll y comparta otro screenshot
- O que pegue las preguntas restantes
- Procesar en iteraciones hasta cubrir todo el formulario
