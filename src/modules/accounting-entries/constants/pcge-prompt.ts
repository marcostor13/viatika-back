interface ExpenseContext {
  idx: number
  categoria: string
  cuenta9xConfigurada?: string
  descripcion: string
  items: string[]
}

export function buildPcgeAccountsPrompt(expenses: ExpenseContext[]): string {
  const expensesText = expenses
    .map(
      e => `${e.idx}. Categoría: ${e.categoria}
   Cuenta 9X ya configurada: ${e.cuenta9xConfigurada || 'no configurada — determinala tú'}
   Descripción: ${e.descripcion || 'sin descripción'}
   Items: ${e.items.join('; ') || 'sin detalle'}`
    )
    .join('\n\n')

  return `Eres un contador público peruano especializado en el Plan de Cuentas General Empresarial (PCGE) del Perú.

Analiza los siguientes comprobantes de gasto y determina las cuentas contables de Clase 9 (analítica) y Clase 63 (destino) que corresponden a cada uno según el PCGE Peru.

TABLA PCGE — CLASE 91 (Cuentas analíticas de explotación):
| Código       | Nombre                                                        |
|--------------|---------------------------------------------------------------|
| 91.3.1.100   | Transporte de carga y mensajería                              |
| 91.3.1.140   | Transporte de pasajeros, movilidad, taxi, traslado            |
| 91.3.1.200   | Almacenamiento y depósito                                     |
| 91.3.1.300   | Comunicaciones, telecomunicaciones                            |
| 91.3.1.410   | Alimentación, restaurantes, comidas, bebidas                  |
| 91.3.1.420   | Hospedaje, alojamiento, hotel                                 |
| 91.3.2.100   | Asesoría y consultoría                                        |
| 91.3.3.100   | Mantenimiento y reparaciones                                  |
| 91.3.4.100   | Publicidad y publicaciones                                    |
| 91.3.5.100   | Alquileres                                                    |
| 91.3.6.100   | Servicios básicos (agua, electricidad, gas)                   |
| 91.3.8.100   | Honorarios profesionales                                      |
| 91.3.9.100   | Otros servicios prestados por terceros                        |

TABLA PCGE — CLASE 63 (Gastos de servicios prestados por terceros):
| Código       | Nombre                                                        |
|--------------|---------------------------------------------------------------|
| 63.1.1.100   | Transporte de carga y mensajería                              |
| 63.1.1.200   | Transporte de pasajeros, movilidad, taxi, traslado, aeropuerto|
| 63.1.2.100   | Almacenamiento y depósito                                     |
| 63.1.3.100   | Comunicaciones, telecomunicaciones, internet, teléfono        |
| 63.1.4.100   | Alimentación, restaurantes, comidas, bebidas, catering        |
| 63.1.4.200   | Hospedaje, alojamiento, hotel                                 |
| 63.2.1.100   | Asesoría y consultoría                                        |
| 63.3.1.100   | Mantenimiento y reparaciones                                  |
| 63.4.1.100   | Publicidad y publicaciones                                    |
| 63.5.1.100   | Alquileres de inmuebles                                       |
| 63.5.2.100   | Alquiler de equipos y maquinaria                              |
| 63.6.1.100   | Servicios básicos (agua, electricidad, gas)                   |
| 63.8.1.100   | Comisiones y corretajes                                       |
| 63.8.2.100   | Vigilancia y seguridad                                        |
| 63.8.3.100   | Honorarios profesionales (médicos, abogados, ingenieros)      |
| 63.8.4.100   | Capacitación y entrenamiento                                  |
| 63.9.1.100   | Otros servicios prestados por terceros                        |

COMPROBANTES A CLASIFICAR:
${expensesText}

INSTRUCCIONES:
- Para cada comprobante elige el par de cuentas (9X y 6X) que mejor describe el gasto.
- Si "Cuenta 9X ya configurada" tiene valor, úsala tal cual para cuenta9x; solo determina cuenta6x.
- Si no está configurada, determina ambas según las tablas.
- Casos típicos: movilidad/taxi → 91.3.1.140 + 63.1.1.200; restaurante/comida → 91.3.1.410 + 63.1.4.100; hotel → 91.3.1.420 + 63.1.4.200.
- La categoría del usuario es la pista principal; los ítems confirman o refinan.
- Responde ÚNICAMENTE con un JSON array, sin texto adicional ni markdown:

[{"idx":1,"cuenta9x":"91.3.1.140","cuenta6x":"63.1.1.200"},...]`
}
