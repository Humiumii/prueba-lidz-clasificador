## Para correr el proyecto en local:

1. Instalar dependencias:
  
  En terminal bash ejecutar:

  `npm install`

2. Asegurar que exista un archivo `.env` en la raíz con la API key con el siguiente formato:
  
  `GEMINI_API_KEY=tu_clave_de_gemini`

3. para ejecutar la prueba en la misma terminal ejecutar:
  
  `npm run probar`

  Esto genera un archivo llamado `resultados_conversaciones.json` con la respuesta

4. Para levantar el servidor HTTP:

  En una terminal nueva

  `npm start`

  Esto lo levanta de manera local

## Para probar via HTTP:

El servidor está desplegado y corriendo en la nube en:

`https://prueba-lidz-clasificador.onrender.com`

Se puede comprobar que el servicio está activo con:

```bash
curl https://prueba-lidz-clasificador.onrender.com/health
```

Para evaluar un chat nuevo mediante HTTP, se puede llamar al endpoint `/evaluar` de la siguiente manera:

Ejemplo: 
```bash
  curl -X POST https://prueba-lidz-clasificador.onrender.com/evaluar \
    -H "Content-Type: application/json" \
    -d '{
      "id": "chat-ejemplo",
      "mensajes": [
        { "de": "lead", "texto": "Hola, busco departamento de 2 dormitorios en Ñuñoa. Tengo 900 UF de pie." },
        { "de": "asistente", "texto": "Hola, sí tenemos unidades disponibles. ¿Para qué fecha buscas?" },
        { "de": "lead", "texto": "Para antes de marzo ojalá." }
      ]
    }'
```
Respuesta esperada es la siguiente:
```json
{
  "id": "chat-ejemplo",
  "resumen": "Lead busca departamento de 2 dormitorios en Ñuñoa con 900 UF de pie antes de marzo.",
  "tipo_asunto": "compra_vivienda",
  "nivel_apuro": "inmediato",
  "presupuesto": {
    "monto_maximo": null,
    "pie_disponible": "900 UF"
  },
  "requiere_humano": true,
  "motivo_humano": "Interés concreto en compra de vivienda con pie disponible para coordinar asesoría y visita.",
  "tipo_depto": "2 dormitorios",
  "metadata": {
    "tokens_entrada": 509,
    "tokens_salida": 120
  }
}
```

## Para las decisiones realizadas:

Decidí modelar las conversaciones definiendo campos y etiquetas claras para que el trabajador sepa exactamente qué pasa en cada chat sin tener que leerlo entero:

1. Nivel de apuro o urgencia (`nivel_apuro`)
Medí la urgencia basándome en qué tan apurada está la persona y en el plazo temporal en el que busca concretar la compra:
- `inmediato`: Leads con plazo corto o urgente (ej: necesitan cambiarse, comprar en una proximidad, etc.). Son los que mayor prioridad tienen.
- `mediano_plazo`: Personas planeando comprar a varios meses o con fecha flexible.
- `sin_apuro`: Personas que solo están mirando o cotizando sin una intención de compra a corto plazo.
- `no_aplica`: Casos descartados que no tienen relación con el negocio de venta (consultas por casos que no atienda la empresa, números equivocados, bromistas o trolls).

2. Tipo de asunto (`tipo_asunto`)
Categoricé el motivo de fondo del contacto en las siguientes opciones:
- `compra_vivienda`: Compra de departamento para vivir.
- `inversion`: Compra con foco en rentabilidad o inversión.
- `cotizando`: Consultas generales de precios o proyectos sin compromiso de compra inmediato.
- `reclamo`: Problemas de postventa o molestias de clientes.
- `intento_engaño`: Intentos de engañar al asistente con instrucciones falsas o transferencias simuladas.
- `numero_equivocado`: Mensajes dirigidos a personas o servicios ajenos.
- `otro`: Otras consultas (casos no considerados en lo ya mencionado).

3. Intervención humana (`requiere_humano` y `motivo_humano`)
Decidí que la intervención humana debía estar guiada por el valor comercial (que genera mas dinero) y el cuidado del tiempo del ejecutivo en cuestion:
- Si la persona tiene intención real de compra o inversión (`compra_vivienda` o `inversion`), o si es un reclamo urgente, se marca `requiere_humano: true` para que un ejecutivo intervenga y cierre la venta.
- Si solo está curioseando, cotizando a futuro, equivocado o intentando engañar al bot, se marca `requiere_humano: false`. El bot puede seguir respondiendo o filtrar el caso, evitando que los ejecutivos pierdan tiempo.

4. Presupuesto y datos clave
- `presupuesto`: Dividido en `monto_maximo` y `pie_disponible`. Si el lead no dice explícitamente cuánto tiene o puede pagar, queda estrictamente en `null` para cumplir con la regla de no alucinar ni inventar datos.
- `tipo_depto`: Tipología buscada ("2 dormitorios", "estudio", etc.), o `null` si no lo especificó.
- `resumen`: Una sola línea concisa con lo central de la conversación.

5. Reglas impuestas a Gemini para evitar respuestas no deseadas:
Para evitar que Gemini entregue cualquier tipo de respuesta libre, inventada o con formatos raros, le impuse reglas estrictas en la configuración:
- Esquema estructurado (Structured Output): Se configuró la API para responder con un JSON estricto (`responseSchema`), asegurando que solo entregue las propiedades que definimos, sin texto de relleno ni introducciones.
- Opciones fijas (Enums): Tanto para `tipo_asunto` como para `nivel_apuro` se limitó a una lista fija de opciones, impidiendo que la IA invente categorías que no correspondan.
- Temperatura baja (0.1): Se dejó en 0.1 para que el modelo sea consistente y objetivo en sus respuestas, evitando que sea creativo o que cambie de opinión entre llamadas.
- Cero alucinación: Se dejó como regla que si un dato no fue dicho explícitamente por el lead, debe ser `null`. No puede inventar montos a partir de precios que el bot haya ofrecido como catálogo.

6. Modelo utilizado y justificación:
Utilice `gemini-3.8-flash`. Probé también la alternativa más barata (`gemini-3.5-flash-lite`), pero en la conversación 1 alucinó el presupuesto del cliente poniendo "4.200 UF" (que era un precio mencionado por el bot, no por el cliente), rompiendo la regla de no inventar datos. En cambio, `gemini-3.8-flash` respetó la regla y dejó el campo en `null`. Como además es un modelo rápido y procesar los 10 chats costó menos de $0.001 USD, convenía usar el 3.8 Flash para asegurar respuestas correctas y evitar engaños o inyecciones de prompt.

7. Estructura del código:
El código se divide de forma simple en dos archivos:
- `server.ts`: Es el servidor Express para recibir los chats por HTTP. Tiene la ruta `/evaluar` para analizar las conversaciones con Gemini y la ruta `/health` para revisar que el servidor esté activo.
- `probar.ts`: Es el script para probar las conversaciones de `fixtures/conversaciones.json` y generar el archivo con los resultados y costos `resultados_conversaciones.json`.

8. Cómo lo probé:
Lo probé en tres pasos simples:
- Primero corrí `probar.ts` con los 10 chats de prueba para verificar que la IA entendiera los casos difíciles (reclamos, arriendos o bromistas) y no inventara información.
- Luego levanté `server.ts` en local con `npm start` para probar que la API respondiera bien a las peticiones HTTP.
- Al final probé el servidor corriendo en Render usando `curl` en `/health` y en `/evaluar` para confirmar que funcionara correctamente en la nube.


## Qué me costó más y cómo lo resolví

Lo que más me costó fue definir cómo categorizar los chats, determinar qué considerábamos realmente más importante y en qué momento exacto debía intervenir un ejecutivo humano. 

Había casos ambiguos (por ejemplo, personas cotizando o pidiendo precios generales sin decir si querían comprar ya). Lo resolví asumiendo criterios de negocio claros: considerar que el objetivo principal es la venta efectiva, por lo que todo lo que apunte a cerrar una compra o atender una molestia urgente va al trabajador, mientras que dudas iniciales, consultas descartadas y curiosos los absorbe la automatización. Con esas asunciones, las reglas quedaron consistentes para clasificar cada caso.


## Costo de procesar las 10 conversaciones

Al ejecutar el script `npm run probar` sobre un conjunto de N conversaciones de prueba (10 en este caso), obtuvimos los siguientes resultados:

- Tokens de entrada: 4.915 tokens
- Tokens de salida: 999 tokens
- Tiempo de procesamiento: ~52,7 segundos
- Costo total en dinero: $0.000668 USD

El script calcula este costo dinámicamente multiplicando los tokens por las tarifas de Gemini Flash ($0.075 USD / 1M input y $0.30 USD / 1M output).

## Qué haría distinto con más tiempo

Con más tiempo me gustaría investigar e integrar herramientas especializadas en clasificación rápida o procesamiento específico, como clasificadores dedicados o herramientas tipo Laya AI, que están pensadas para clasificar información de forma más directa y eficiente que consultar a un LLM conversacional completo para cada dato. 

Para esta prueba el problema estaba acotado a evaluar estas conversaciones y las reglas requerían expresamente utilizar la API de Gemini entregada, por lo que Gemini con Structured Outputs fue la solución elegida. Pero ante un volumen de cientos o miles de chats diarios, evaluar esas tecnologías alternativas sería muy valioso para abarcar casos más grandes, reducir aún más los tiempos de respuesta y optimizar costos.
