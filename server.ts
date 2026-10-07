import dotenv from 'dotenv';
dotenv.config();

import express, { type Request, type Response } from 'express';
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';

// ----------------------------------------------------------------------------
// 1. VALIDAR KEY
// ----------------------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Error: Falta configurar GEMINI_API_KEY en el archivo .env');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

// ----------------------------------------------------------------------------
// 2. ESQUEMA GEMINI
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 3. CONFIGURACION DEL MODELO GEMINI E INSTRUCCIONES
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 4. FUNCION DE EVALUACION
// ----------------------------------------------------------------------------
export async function evaluarChat(mensajes: Array<{ de: string; texto: string }>) {
  const textoChat = mensajes
    .map((m) => `[${m.de.toUpperCase()}]: ${m.texto}`)
    .join('\n');

  const resultado = await modelo.generateContent(`Analiza esta conversacion:\n\n${textoChat}`);
  const respuesta = await resultado.response;
  const jsonEvaluacion = JSON.parse(respuesta.text());
  const tokens = respuesta.usageMetadata;

  return {
    ...jsonEvaluacion,
    metadata: {
      tokens_entrada: tokens?.promptTokenCount || 0,
      tokens_salida: tokens?.candidatesTokenCount || 0,
    },
  };
}

// ----------------------------------------------------------------------------
// 5. RUTAS HTTP (API)
// ----------------------------------------------------------------------------
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    mensaje: 'Servidor evaluador funcionando correctamente',
    timestamp: new Date().toISOString(),
  });
});

app.post('/evaluar', async (req: Request, res: Response): Promise<void> => {
  try {
    const conversacion = req.body;

    if (!conversacion || !conversacion.mensajes || !Array.isArray(conversacion.mensajes)) {
      res.status(400).json({
        error: 'Peticion invalida',
        detalle: 'Debes enviar un JSON con el formato: { id: string, mensajes: [{ de: "lead"|"asistente", texto: string }] }',
      });
      return;
    }

    const evaluacion = await evaluarChat(conversacion.mensajes);

    res.status(200).json({
      id: conversacion.id || 'desconocido',
      ...evaluacion,
    });
  } catch (error: any) {
    console.error('Error al procesar conversacion:', error);
    res.status(500).json({
      error: 'Error interno al evaluar la conversacion con IA',
      mensaje: error?.message || 'Error desconocido',
    });
  }
});

// ----------------------------------------------------------------------------
// 6. INICIALIZACION DEL SERVIDOR
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('===================================================');
  console.log(`Servidor de Lidz encendido y escuchando en el puerto ${PORT}`);
  console.log(`- Comprobar salud : GET  http://localhost:${PORT}/health`);
  console.log(`- Evaluar chat    : POST http://localhost:${PORT}/evaluar`);
  console.log('===================================================');
});
