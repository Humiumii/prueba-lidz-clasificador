import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';

// 1. Validar que la API Key exista
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Error: Falta configurar GEMINI_API_KEY en el archivo .env');
  process.exit(1);
}

// Precios oficiales de Gemini Flash por millon de tokens dato en internet
const PRECIO_INPUT_POR_MILLON_USD = 0.075;
const PRECIO_OUTPUT_POR_MILLON_USD = 0.30;

// 2. Leer las conversaciones
const conversacionesRaw = fs.readFileSync('fixtures/conversaciones.json', 'utf-8');
const conversaciones = JSON.parse(conversacionesRaw);

console.log(`Cargadas ${conversaciones.length} conversaciones desde fixtures/conversaciones.json\n`);

// 3. Esquema de respuesta Gemini
const esquemaRespuesta: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    resumen: {
      type: SchemaType.STRING,
      description: 'Resumen en exactamente 1 linea para el ejecutivo comercial.',
    },
    tipo_asunto: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: [
        'compra_vivienda',
        'inversion',
        'cotizando',
        'reclamo',
        'intento_engaño',
        'numero_equivocado',
        'otro',
      ],
      description: 'Categoria principal identificada.',
    },
    nivel_apuro: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['inmediato', 'mediano_plazo', 'sin_apuro', 'no_aplica'],
      description: 'Nivel de apuro temporal del lead.',
    },
    tipo_depto: {
      type: SchemaType.STRING,
      nullable: true,
      description: 'Tipologia que busca. Si no se menciona explicitamente, debe ser null.',
    },
    presupuesto: {
      type: SchemaType.OBJECT,
      properties: {
        monto_maximo: {
          type: SchemaType.STRING,
          nullable: true,
          description: 'Monto total maximo que dijo poder pagar. Si no existe la informacion, debe ser null.',
        },
        pie_disponible: {
          type: SchemaType.STRING,
          nullable: true,
          description: 'Monto de pie o ahorro mencionado. Si no existe la informacion, debe ser null.',
        },
      },
      required: [],
    },
    requiere_humano: {
      type: SchemaType.BOOLEAN,
      description: 'true si un ejecutivo humano debe intervenir para cerrar la venta o atender reclamos.',
    },
    motivo_humano: {
      type: SchemaType.STRING,
      nullable: true,
      description: 'Motivo de la intervencion humana, o null si no se requiere.',
    },
  },
  required: ['resumen', 'tipo_asunto', 'nivel_apuro', 'presupuesto', 'requiere_humano'],
};

// 4. Configuracion gemini
const genAI = new GoogleGenerativeAI(apiKey);
const modelo = genAI.getGenerativeModel({
  model: 'gemini-3.8-flash',
  systemInstruction: 
  				`Eres el evaluador de conversaciones inmobiliarias de Lidz para WhatsApp.

				REGLAS GENERALES:
				1. INTEGRIDAD DE DATOS (CERO ALUCINACION):
				Para cualquier campo del esquema, si la informacion no existe o no fue dicha explicitamente por el lead, dicho campo DEBE ser null. Si la informacion existe, se extrae fielmente. Jamas inventes montos totales a partir de precios que ofrezca el asistente ni asumas datos no escritos.

				2. CLASIFICACION:
				- Identifica el tipo de asunto segun el interes real manifestado por el lead (compra_vivienda, inversion, cotizando, reclamo, intento_engaño, numero_equivocado, otro).
				- Identifica el nivel de apuro temporal: "inmediato" (plazo urgente o entrega inmediata), "mediano_plazo" (planes a meses), "sin_apuro" (solo mirando), "no_aplica" (descarte, arriendo, equivocado, troll).

				3. INTERVENCION HUMANA (ENFOQUE DE CIERRE COMERCIAL):
				- Asigna requiere_humano en true si:
					* El lead tiene intencion real y concreta de compra o inversion (compra_vivienda, inversion), ya que un ejecutivo humano debe tomar el contacto para cerrar la venta y asesorar el proceso.
					* Es un reclamo urgente que requiere atencion y resolucion de un ejecutivo.
				- Asigna requiere_humano en false si:
					* El lead solo esta cotizando o curioseando sin definir compra (el bot puede continuar respondiendo de forma automatizada).
					* Son consultas descartadas (arriendos, fuera de foco), numeros equivocados o intentos de engaño/trolls (el bot filtra estos casos para no quitar tiempo de ventas al equipo humano).

				4. RESUMEN:
				Debe ser exactamente de una linea clara y directa para el ejecutivo comercial.`,
				generationConfig: {
					responseMimeType: 'application/json',
					responseSchema: esquemaRespuesta,
					temperature: 0.1,
				},
});

// 5. Ejecucion en grupo de N conversaciones
async function ejecutarLote() {
  const resultadosFinales = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const tiempoInicio = Date.now();

  for (let i = 0; i < conversaciones.length; i++) {
    const conv = conversaciones[i];
    console.log(`[${i + 1}/${conversaciones.length}] Procesando ${conv.id}...`);

    const textoChat = conv.mensajes
      .map((m: any) => `[${m.de.toUpperCase()}]: ${m.texto}`)
      .join('\n');

    const resultado = await modelo.generateContent(
      `Analiza esta conversacion:\n\n${textoChat}`
    );

    const respuesta = await resultado.response;
    const jsonEvaluacion = JSON.parse(respuesta.text());

    const tokens = respuesta.usageMetadata;
    const inputTokens = tokens?.promptTokenCount || 0;
    const outputTokens = tokens?.candidatesTokenCount || 0;

    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    const evaluacionCompleta = {
      id: conv.id,
      ...jsonEvaluacion,
      metadata: {
        tokens_entrada: inputTokens,
        tokens_salida: outputTokens,
      },
    };

    resultadosFinales.push(evaluacionCompleta);
  }

  const duracionSegundos = ((Date.now() - tiempoInicio) / 1000).toFixed(2);
  const costoTotalUSD = (
    (totalInputTokens / 1_000_000) * PRECIO_INPUT_POR_MILLON_USD +
    (totalOutputTokens / 1_000_000) * PRECIO_OUTPUT_POR_MILLON_USD
  ).toFixed(6);

  // Guardar JSON RESPUESTA 
  const salida = {
    fecha: new Date().toISOString(),
    total_conversaciones: conversaciones.length,
    tiempo_ejecucion_segundos: duracionSegundos,
    metricas: {
      total_tokens_entrada: totalInputTokens,
      total_tokens_salida: totalOutputTokens,
      costo_total_usd: Number(costoTotalUSD),
    },
    resultados: resultadosFinales,
  };

  fs.writeFileSync('resultados_conversaciones.json', JSON.stringify(salida, null, 2), 'utf-8');

  console.log('\n================================================================');
  console.log('EVALUACION COMPLETADA CON EXITO');
  console.log('================================================================');
  console.log(`Conversaciones procesadas : ${conversaciones.length}`);
  console.log(`Tiempo total              : ${duracionSegundos} segundos`);
  console.log(`Total tokens de entrada   : ${totalInputTokens}`);
  console.log(`Total tokens de salida    : ${totalOutputTokens}`);
  console.log(`Costo total en dinero     : $${costoTotalUSD} USD`);
  console.log('Archivo guardado en       : resultados_conversaciones.json');
  console.log('================================================================\n');

  for (const r of resultadosFinales) {
    console.log(`- ${r.id} | Asunto: ${r.tipo_asunto.padEnd(16)} | Apuro: ${r.nivel_apuro.padEnd(14)} | Humano: ${r.requiere_humano ? 'SI' : 'NO'}`);
    console.log(`  Motivo humano: ${r.motivo_humano || 'N/A'}`);
    console.log(`  Resumen: ${r.resumen}\n`);
  }
}

ejecutarLote().catch((error) => {
  console.error('Error al evaluar el lote:', error);
});
