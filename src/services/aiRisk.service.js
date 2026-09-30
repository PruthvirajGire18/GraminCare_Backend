import { env } from '../config/env.js'

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const PRIORITIES = ['ROUTINE', 'NORMAL', 'URGENT', 'EMERGENCY']
const API_URL = 'https://api.openai.com/v1/chat/completions'

export class AIRiskServiceError extends Error {
  constructor(code) {
    super(code)
    this.name = 'AIRiskServiceError'
    this.code = code
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safeClinicalText(value, patientName = '') {
  if (typeof value !== 'string') return ''
  let safe = value
  if (patientName.trim().length > 1) {
    safe = safe.replace(new RegExp(escapeRegExp(patientName.trim()), 'ig'), '[redacted]')
  }
  return safe
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[redacted]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted]')
}

export function buildRiskInput({ patient = {}, visit = {} } = {}) {
  const patientName = typeof patient.fullName === 'string' ? patient.fullName : ''
  const dob = patient.dateOfBirth ? new Date(patient.dateOfBirth) : null
  let ageYears = null
  if (dob && !Number.isNaN(dob.getTime())) {
    const now = new Date()
    ageYears = now.getFullYear() - dob.getFullYear()
    if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) ageYears -= 1
    if (ageYears < 0 || ageYears > 125) ageYears = null
  }
  const cleanList = (items) => (Array.isArray(items) ? items : []).slice(0, 30)
    .map((item) => safeClinicalText(String(item), patientName).slice(0, 300))

  return {
    ageYears,
    gender: ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'].includes(patient.gender) ? patient.gender : 'UNKNOWN',
    symptoms: {
      chiefComplaint: safeClinicalText(visit.symptoms?.chiefComplaint || '', patientName).slice(0, 1000),
      details: safeClinicalText(visit.symptoms?.details || '', patientName).slice(0, 4000),
      durationDays: Number.isInteger(visit.symptoms?.durationDays) ? visit.symptoms.durationDays : null,
    },
    vitals: {
      temperatureC: visit.vitals?.temperatureC ?? null,
      oxygenSaturationPercent: visit.vitals?.oxygenSaturationPercent ?? null,
      heartRateBpm: visit.vitals?.heartRateBpm ?? null,
      respiratoryRatePerMinute: visit.vitals?.respiratoryRatePerMinute ?? null,
      systolicMmHg: visit.vitals?.systolicMmHg ?? null,
      diastolicMmHg: visit.vitals?.diastolicMmHg ?? null,
    },
    medicalHistory: cleanList(visit.medicalHistory),
    allergies: cleanList(visit.allergies),
    currentMedicines: cleanList(visit.currentMedicines),
    ashaObservations: safeClinicalText(visit.observations || '', patientName).slice(0, 4000),
  }
}

function hasAny(text, expressions) {
  return expressions.some((expression) => expression.test(text))
}

export function createMockRiskAssessment(input = {}) {
  const vitals = input.vitals || {}
  const narrative = [input.symptoms?.chiefComplaint, input.symptoms?.details, input.ashaObservations]
    .filter(Boolean).join(' ').toLowerCase()
  const factors = []
  let critical = false
  let high = false
  let medium = false

  const add = (factor, level) => {
    factors.push(factor)
    if (level === 'CRITICAL') critical = true
    else if (level === 'HIGH') high = true
    else if (level === 'MEDIUM') medium = true
  }

  if (vitals.oxygenSaturationPercent !== null && vitals.oxygenSaturationPercent !== undefined) {
    if (vitals.oxygenSaturationPercent <= 84) add(`Very low SpO2 (${vitals.oxygenSaturationPercent}%)`, 'CRITICAL')
    else if (vitals.oxygenSaturationPercent <= 90) add(`Low SpO2 (${vitals.oxygenSaturationPercent}%)`, 'HIGH')
    else if (vitals.oxygenSaturationPercent <= 94) add(`Reduced SpO2 (${vitals.oxygenSaturationPercent}%)`, 'MEDIUM')
  }
  if (vitals.temperatureC !== null && vitals.temperatureC !== undefined) {
    if (vitals.temperatureC >= 40.5) add(`Very high temperature (${vitals.temperatureC} °C)`, 'CRITICAL')
    else if (vitals.temperatureC >= 39) add(`High temperature (${vitals.temperatureC} °C)`, 'HIGH')
    else if (vitals.temperatureC >= 38) add(`Elevated temperature (${vitals.temperatureC} °C)`, 'MEDIUM')
  }
  if (vitals.heartRateBpm !== null && vitals.heartRateBpm !== undefined) {
    if (vitals.heartRateBpm >= 150 || vitals.heartRateBpm <= 35) add(`Severely abnormal heart rate (${vitals.heartRateBpm} bpm)`, 'CRITICAL')
    else if (vitals.heartRateBpm >= 130 || vitals.heartRateBpm <= 40) add(`High-risk heart rate (${vitals.heartRateBpm} bpm)`, 'HIGH')
    else if (vitals.heartRateBpm >= 100) add(`Elevated heart rate (${vitals.heartRateBpm} bpm)`, 'MEDIUM')
  }
  if (vitals.respiratoryRatePerMinute !== null && vitals.respiratoryRatePerMinute !== undefined) {
    if (vitals.respiratoryRatePerMinute >= 35 || vitals.respiratoryRatePerMinute <= 6) add(`Severely abnormal breathing rate (${vitals.respiratoryRatePerMinute}/min)`, 'CRITICAL')
    else if (vitals.respiratoryRatePerMinute >= 30 || vitals.respiratoryRatePerMinute <= 8) add(`High-risk breathing rate (${vitals.respiratoryRatePerMinute}/min)`, 'HIGH')
    else if (vitals.respiratoryRatePerMinute >= 22) add(`Elevated breathing rate (${vitals.respiratoryRatePerMinute}/min)`, 'MEDIUM')
  }
  if (vitals.systolicMmHg !== null && vitals.systolicMmHg !== undefined) {
    if (vitals.systolicMmHg < 70) add(`Very low systolic blood pressure (${vitals.systolicMmHg} mmHg)`, 'CRITICAL')
    else if (vitals.systolicMmHg < 90) add(`Low systolic blood pressure (${vitals.systolicMmHg} mmHg)`, 'HIGH')
    else if (vitals.systolicMmHg >= 180) add(`Very high systolic blood pressure (${vitals.systolicMmHg} mmHg)`, 'HIGH')
    else if (vitals.systolicMmHg >= 160) add(`Elevated systolic blood pressure (${vitals.systolicMmHg} mmHg)`, 'MEDIUM')
  }

  if (hasAny(narrative, [/unconscious|unresponsive|seizure|blue lips|unable to breathe|not breathing/])) {
    add('Critical symptom or observation reported', 'CRITICAL')
  } else if (hasAny(narrative, [/difficulty breathing|breathlessness|shortness of breath|chest pain|severe bleeding/])) {
    add('Potentially urgent symptom reported', 'HIGH')
  } else if (hasAny(narrative, [/moderate symptoms|moderate illness|fever|persistent cough|vomit|diarrh|moderate pain|weakness|dehydrat|dizziness/])) {
    add('Symptoms need clinical review', 'MEDIUM')
  }

  if (Number.isInteger(input.symptoms?.durationDays) && input.symptoms.durationDays >= 7) {
    add(`Symptoms reported for ${input.symptoms.durationDays} days`, 'MEDIUM')
  }
  if ((input.ageYears !== null && input.ageYears !== undefined) && (input.ageYears < 5 || input.ageYears >= 65)) {
    add('Age may increase the need for timely clinical review', 'MEDIUM')
  }
  if (Array.isArray(input.medicalHistory) && input.medicalHistory.some((item) => /asthma|heart|cardiac|diabet|kidney|immune|immunocompromis/i.test(item))) {
    add('Relevant medical history recorded', 'MEDIUM')
  }

  const riskLevel = critical ? 'CRITICAL' : high ? 'HIGH' : medium ? 'MEDIUM' : 'LOW'
  const priority = { LOW: 'ROUTINE', MEDIUM: 'NORMAL', HIGH: 'URGENT', CRITICAL: 'EMERGENCY' }[riskLevel]
  const riskScore = riskLevel === 'CRITICAL' ? Math.min(100, 94 + Math.max(0, factors.length - 1) * 2)
    : riskLevel === 'HIGH' ? Math.min(89, 72 + Math.max(0, factors.length - 1) * 4)
      : riskLevel === 'MEDIUM' ? Math.min(69, 42 + Math.max(0, factors.length - 1) * 5)
        : 8
  const recommendation = {
    LOW: 'Routine doctor review is appropriate based on the information recorded.',
    MEDIUM: 'Doctor review recommended; consider the reported symptoms and recorded observations.',
    HIGH: 'Urgent doctor review recommended.',
    CRITICAL: 'Emergency doctor review recommended now.',
  }[riskLevel]

  return { riskLevel, riskScore, priority, factors: [...new Set(factors)].slice(0, 8), recommendation }
}

export function validateRiskAssessment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AIRiskServiceError('INVALID_AI_RESPONSE')
  const allowedFields = new Set(['riskLevel', 'riskScore', 'priority', 'factors', 'recommendation'])
  if (Object.keys(value).some((field) => !allowedFields.has(field))) throw new AIRiskServiceError('INVALID_AI_RESPONSE')
  const { riskLevel, riskScore, priority, factors, recommendation } = value
  if (!RISK_LEVELS.includes(riskLevel) || !Number.isInteger(riskScore) || riskScore < 0 || riskScore > 100
    || !PRIORITIES.includes(priority) || !Array.isArray(factors) || factors.length > 8
    || factors.some((factor) => typeof factor !== 'string' || !factor.trim() || factor.length > 240)
    || typeof recommendation !== 'string' || !recommendation.trim() || recommendation.length > 1000
    || factors.some((factor) => /\b(diagnos(?:e|is|tic)|prescri(?:be|ption)|dosage|treatment plan)\b/i.test(factor))
    || !/\b(doctor|clinician|clinical review|medical review)\b/i.test(recommendation)
    || /\b(diagnos(?:e|is|tic)|prescri(?:be|ption)|medicat(?:e|ion)|medicine|dosage|treatment|take|start|stop|increase|decrease|administer|give)\b/i.test(recommendation)) {
    throw new AIRiskServiceError('INVALID_AI_RESPONSE')
  }
  return {
    riskLevel,
    riskScore,
    priority,
    factors: factors.map((factor) => factor.trim()),
    recommendation: recommendation.trim(),
  }
}

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['riskLevel', 'riskScore', 'priority', 'factors', 'recommendation'],
  properties: {
    riskLevel: { type: 'string', enum: RISK_LEVELS },
    riskScore: { type: 'integer', minimum: 0, maximum: 100 },
    priority: { type: 'string', enum: PRIORITIES },
    factors: { type: 'array', maxItems: 8, items: { type: 'string' } },
    recommendation: { type: 'string' },
  },
}

async function openAiAssessment(input, { apiKey, model, fetchImpl }) {
  if (!apiKey) throw new AIRiskServiceError('AI_CONFIGURATION_MISSING')
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 20000)
  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        model,
        store: false,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Provide preliminary risk prioritization for doctor review only. Do not diagnose, prescribe, recommend medicines, or make autonomous clinical decisions. Use only supplied de-identified clinical signals. Factors must describe supplied observations, symptoms, or vitals. Keep recommendation to doctor or clinical review urgency, such as “Urgent doctor review recommended.” A doctor remains responsible for clinical assessment.',
          },
          { role: 'user', content: JSON.stringify(input) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'preliminary_risk_assessment', strict: true, schema: responseSchema },
        },
      }),
    })
    if (!response.ok) throw new AIRiskServiceError(`AI_HTTP_${response.status}`)
    const body = await response.json()
    const message = body?.choices?.[0]?.message
    if (message?.refusal) throw new AIRiskServiceError('AI_REFUSAL')
    if (typeof message?.content !== 'string') throw new AIRiskServiceError('INVALID_AI_RESPONSE')
    let parsed
    try { parsed = JSON.parse(message.content) } catch { throw new AIRiskServiceError('INVALID_AI_RESPONSE') }
    return validateRiskAssessment(parsed)
  } catch (error) {
    if (error instanceof AIRiskServiceError) throw error
    if (error.name === 'AbortError') throw new AIRiskServiceError('AI_TIMEOUT')
    throw new AIRiskServiceError('AI_UNAVAILABLE')
  } finally {
    clearTimeout(timeout)
  }
}

export async function generateRiskAssessment(input, options = {}) {
  const mode = options.mode || env.aiMode
  if (mode === 'mock') return { ...createMockRiskAssessment(input), mode: 'mock', model: 'deterministic-demo-rules' }
  if (mode !== 'openai') throw new AIRiskServiceError('AI_MODE_INVALID')
  const result = await openAiAssessment(input, {
    apiKey: options.apiKey ?? env.openaiApiKey,
    model: options.model || env.openaiModel,
    fetchImpl: options.fetchImpl || globalThis.fetch,
  })
  return { ...result, mode: 'openai', model: options.model || env.openaiModel }
}
