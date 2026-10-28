// Levanta el servidor y publica el menú del cliente.
import './iniciar.env.mjs'
import express from 'express'
import path from 'node:path'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

import {
    obtenerRecetas,
    obtenerRecetaPorId,
    realizarPedido,
    obtenerPedidos,
    cambiarEstadoPedido
} from './funciones.mjs'

const PUERTO = process.env.PUERTO || 4000
const app = express()

const carpetaCliente = path.resolve('./fronts/front-cliente')
const carpetaAdmin = path.resolve('./fronts/front-admin')
const carpetaLogin = path.resolve('./fronts/front-login')

function comprobarToken(req, res, next) {
    const token = req.signedCookies.token
    if (!token || !process.env.FIRMA_JWT) return res.redirect('/login')

    jwt.verify(token, process.env.FIRMA_JWT, (error, payload) => {
        if (error) return res.redirect('/login')
        req.usuario = payload
        next()
    })
}

function comprobarTokenApi(req, res, next) {
    const token = req.signedCookies.token
    if (!token || !process.env.FIRMA_JWT) {
        return res.status(401).json({ mensaje: 'Sesión de administrador no válida.' })
    }

    jwt.verify(token, process.env.FIRMA_JWT, (error, payload) => {
        if (error) return res.status(401).json({ mensaje: 'Sesión de administrador no válida.' })
        req.usuario = payload
        next()
    })
}

app.use(express.json({ limit: '32kb' }))
app.use(cookieParser(process.env.FIRMA_COOKIE))

app.post('/autenticar', (req, res) => {
    const { usuario, pass } = req.body || {}
    const usuarioAdmin = process.env.ADMIN_USUARIO
    const hashAdmin = process.env.ADMIN_PASSWORD_HASH

    if (!process.env.FIRMA_COOKIE || !process.env.FIRMA_JWT || !usuarioAdmin || !hashAdmin) {
        return res.status(503).json({ mensaje: 'El acceso de administrador no está configurado en el servidor.' })
    }
    if (typeof usuario !== 'string' || typeof pass !== 'string' || !usuario || !pass) {
        return res.status(400).json({ mensaje: 'Ingresá usuario y contraseña.' })
    }

    let credencialesValidas = false
    try {
        credencialesValidas = usuario === usuarioAdmin && bcrypt.compareSync(pass, hashAdmin)
    } catch (error) {
        console.error('La contraseña de administrador configurada no es un hash bcrypt válido.')
        return res.status(503).json({ mensaje: 'La configuración del administrador no es válida.' })
    }
    if (!credencialesValidas) {
        return res.status(401).json({ mensaje: 'contraseña incorrecta.' })
    }

    const token = jwt.sign({ usuario: usuarioAdmin }, process.env.FIRMA_JWT, { expiresIn: '1h' })
    res.cookie('token', token, {
        sameSite: 'lax',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        signed: true,
        maxAge: 60 * 60 * 1000
    })
    res.json({ mensaje: 'Sesión iniciada.' })
})

app.get('/cerrar-sesion', (req, res) => {
    res.clearCookie('token', {
        sameSite: 'lax',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        signed: true
    })
    res.redirect('/login')
})

app.get('/api/v1/recetas', obtenerRecetas) // esta funcion devuelve todas las recetas.

app.get('/api/v1/recetas/:id', obtenerRecetaPorId)

app.post('/api/v1/pedidos', realizarPedido)

app.get('/api/v1/admin/pedidos', comprobarTokenApi, obtenerPedidos)

app.put('/api/v1/admin/pedidos/:id', comprobarTokenApi, cambiarEstadoPedido)

app.use('/imagen', express.static(path.resolve('./imagenes')))
app.get('/', (req, res) => {
    res.sendFile('Principal.html', { root: carpetaCliente })
})
app.use('/cliente', express.static(carpetaCliente))
app.get('/login', (req, res) => {
    res.sendFile('index.html', { root: carpetaLogin })
})
app.use('/admin', comprobarToken, express.static(carpetaAdmin))

app.listen(PUERTO, () => {
    console.log('Servidor andando en http://localhost:' + PUERTO)
})