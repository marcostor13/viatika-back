// FIX temporal (escritura): reasigna el clientId de un usuario puntual a un cliente real existente.
// Verifica antes y después. Se elimina tras usarlo.
require('dotenv').config()
require('dns').setServers(['8.8.8.8', '1.1.1.1'])
const mongoose = require('mongoose')

const EMAIL = 'marcosorlandotorresalarcon@gmail.com'
const NEW_CLIENT_ID = '6a0741202ec087bd832c0364' // TEMA LITOCLEAN

async function run() {
  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI no definida')
  await mongoose.connect(uri)

  const client = await mongoose.connection
    .collection('clients')
    .findOne({ _id: new mongoose.Types.ObjectId(NEW_CLIENT_ID) })
  if (!client) throw new Error('El cliente destino no existe, abortando.')
  console.log('Cliente destino confirmado:', client.comercialName || client.businessName)

  const before = await mongoose.connection
    .collection('users')
    .findOne({ email: EMAIL })
  if (!before) throw new Error('Usuario no encontrado, abortando.')
  console.log('clientId ANTES:', String(before.clientId))

  const result = await mongoose.connection.collection('users').updateOne(
    { email: EMAIL },
    { $set: { clientId: new mongoose.Types.ObjectId(NEW_CLIENT_ID) } }
  )
  console.log('Documentos modificados:', result.modifiedCount)

  const after = await mongoose.connection
    .collection('users')
    .findOne({ email: EMAIL })
  console.log('clientId DESPUÉS:', String(after.clientId))

  await mongoose.disconnect()
}

run().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
