import menu from './menu.mjs' // <-- esto importa el menu.mjs a este archivo.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const carpetaDatos = path.dirname(fileURLToPath(import.meta.url))
const archivoPedidos = process.env.PEDIDOS_FILE
    ? path.resolve(process.env.PEDIDOS_FILE)
    : path.join(carpetaDatos, 'data', 'pedidos.json')

let colaGuardado = Promise.resolve()

//1° Funcion para app.get('/api/v1/recetas') mostrara todo los datos del menú
export function obtenerRecetas(req, res) {
    res.json(menu.datos) // lo devolvera en un formato json
}

//2° Funcion para app.get('/api/v1/recetas/:id') mostrara todo los datos del menú por id
export function obtenerRecetaPorId(req, res) {
    const id_receta = Number(req.params.id) // verificara y convertira el id a numero

    const recetaFiltrada = menu.datos.filter((receta) => {
        return id_receta === Number(receta.id) // verifica si el id es igual al id de la receta
    })

    if (recetaFiltrada.length > 0) {
        res.json(recetaFiltrada)
    } else {
        res.status(404).json({
            mensaje: "No se encuentra ese menu"
        })
    }
}

async function leerPedidos() {
    try {
        const contenido = await readFile(archivoPedidos, 'utf8')
        const pedidos = JSON.parse(contenido)
        if (!Array.isArray(pedidos)) {
            throw new Error('El archivo de pedidos debe contener una lista.')
        }
        return pedidos
    } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
    }
}

function modificarPedidos(modificar) {
    const operacion = colaGuardado.then(async () => {
        const pedidos = await leerPedidos()
        const resultado = modificar(pedidos)

        await mkdir(path.dirname(archivoPedidos), { recursive: true })
        const archivoTemporal = `${archivoPedidos}.${process.pid}.${Date.now()}.tmp`
        try {
            await writeFile(archivoTemporal, `${JSON.stringify(pedidos, null, 2)}\n`, 'utf8')
            await rename(archivoTemporal, archivoPedidos)
        } catch (error) {
            try {
                await unlink(archivoTemporal)
            } catch (errorLimpieza) {
                if (errorLimpieza.code !== 'ENOENT') {
                    console.error('No se pudo limpiar el archivo temporal de pedidos:', errorLimpieza)
                }
            }
            throw error
        }

        return resultado
    })

    colaGuardado = operacion.then(() => undefined, () => undefined)
    return operacion
}

function guardarPedido(pedido) {
    return modificarPedidos((pedidos) => {
        pedido.id_pedido = pedidos.reduce((mayor, actual) => Math.max(mayor, actual.id_pedido || 0), 0) + 1
        pedidos.push(pedido)
        return pedido.id_pedido
    })
}

function validarPedido(datos) {
    const errores = []
    const cliente = datos.cliente && typeof datos.cliente === 'object' ? datos.cliente : {}
    const nombre = typeof cliente.nombre === 'string' ? cliente.nombre.trim() : ''
    const apellido = typeof cliente.apellido === 'string' ? cliente.apellido.trim() : ''
    const telefono = typeof cliente.telefono === 'string' ? cliente.telefono.trim() : ''
    const direccion = typeof cliente.direccion === 'string' ? cliente.direccion.trim() : ''
    const email = typeof cliente.email === 'string' ? cliente.email.trim() : ''
    const observacion = typeof datos.observacion === 'string' ? datos.observacion.trim() : ''

    if (!nombre || nombre.length > 80) errores.push('El nombre es obligatorio (máximo 80 caracteres).')
    if (!apellido || apellido.length > 80) errores.push('El apellido es obligatorio (máximo 80 caracteres).')
    if (!/^[0-9+\-\s()]{6,20}$/.test(telefono)) errores.push('Ingresá un teléfono válido.')
    if (!['local', 'delivery'].includes(datos.tipo_entrega)) errores.push('Elegí retiro en local o delivery.')
    if (datos.tipo_entrega === 'delivery' && !direccion) errores.push('La dirección es obligatoria para delivery.')
    if (direccion.length > 200) errores.push('La dirección no puede superar los 200 caracteres.')
    if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        errores.push('Ingresá un email válido.')
    }
    if (!['efectivo', 'transferencia', 'mercadopago'].includes(datos.metodo_pago)) {
        errores.push('Elegí una forma de pago.')
    }
    if (observacion.length > 300) errores.push('La observación no puede superar los 300 caracteres.')

    const cantidades = new Map()
    if (!Array.isArray(datos.items) || datos.items.length === 0) {
        errores.push('Agregá al menos un producto al pedido.')
    } else if (datos.items.length > 50) {
        errores.push('El pedido tiene demasiados productos.')
    } else {
        let itemInvalido = false
        for (const item of datos.items) {
            const id = Number(item?.id_producto)
            const cantidad = Number(item?.cantidad)
            if (!Number.isInteger(id) || id < 1 || !Number.isInteger(cantidad) || cantidad < 1) {
                itemInvalido = true
                continue
            }
            cantidades.set(id, (cantidades.get(id) || 0) + cantidad)
        }
        if (itemInvalido) errores.push('Hay un producto o cantidad inválidos.')
        if ([...cantidades.values()].some((cantidad) => cantidad > 99)) {
            errores.push('No se pueden pedir más de 99 unidades del mismo producto.')
        }
    }

    return {
        errores,
        limpio: {
            nombre,
            apellido,
            telefono,
            direccion: direccion || null,
            email: email || null,
            observacion: observacion || null,
            tipo_entrega: datos.tipo_entrega,
            metodo_pago: datos.metodo_pago,
            cantidades
        }
    }
}

export async function realizarPedido(req, res) {
    const { errores, limpio } = validarPedido(req.body || {})
    if (errores.length > 0) {
        return res.status(400).json({ mensaje: 'Revisá los datos del pedido.', errores })
    }

    const items = []
    for (const [id, cantidad] of limpio.cantidades) {
        const producto = menu.datos.find((item) => item.id === id)
        if (!producto) {
            return res.status(400).json({ mensaje: 'El pedido incluye un producto que no existe.' })
        }
        const subtotal = producto.precio * cantidad
        if (!Number.isSafeInteger(subtotal)) {
            return res.status(400).json({ mensaje: 'El importe del pedido es demasiado grande.' })
        }
        items.push({
            id_producto: producto.id,
            nombre: producto.nombre,
            cantidad,
            precio: producto.precio,
            subtotal
        })
    }

    const montoTotal = items.reduce((total, item) => total + item.subtotal, 0)
    if (!Number.isSafeInteger(montoTotal)) {
        return res.status(400).json({ mensaje: 'El importe del pedido es demasiado grande.' })
    }

    const pedido = {
        fecha_hora: new Date().toISOString(),
        tipo_entrega: limpio.tipo_entrega,
        estado: 'en preparación',
        monto_total: montoTotal,
        observacion: limpio.observacion,
        cliente: {
            nombre: limpio.nombre,
            apellido: limpio.apellido,
            telefono: limpio.telefono,
            direccion: limpio.direccion,
            email: limpio.email
        },
        metodo_pago: limpio.metodo_pago,
        estado_pago: 'pendiente',
        items
    }

    try {
        const idPedido = await guardarPedido(pedido)
        res.status(201).json({
            mensaje: 'Pedido guardado correctamente.',
            id_pedido: idPedido,
            estado: pedido.estado,
            monto_total: pedido.monto_total
        })
    } catch (error) {
        console.error('Error al guardar el pedido:', error)
        res.status(500).json({ mensaje: 'No se pudo guardar el pedido. Intentá nuevamente.' })
    }
}

export async function obtenerPedidos(req, res) {
    const estado = req.query.estado
    const estadosPermitidos = ['en preparación', 'listo', 'cancelado']
    if (estado && !estadosPermitidos.includes(estado)) {
        return res.status(400).json({ mensaje: 'El filtro de estado no es válido.' })
    }

    try {
        const pedidos = await leerPedidos()
        const resultado = pedidos
            .filter((pedido) => !estado || pedido.estado === estado)
            .sort((a, b) => a.id_pedido - b.id_pedido)
            .map((pedido) => ({
                ...pedido,
                nombre: pedido.cliente.nombre,
                apellido: pedido.cliente.apellido,
                telefono: pedido.cliente.telefono,
                direccion: pedido.cliente.direccion
            }))

        res.json(resultado)
    } catch (error) {
        console.error('Error al leer los pedidos para administración:', error)
        res.status(500).json({ mensaje: 'No se pudieron cargar los pedidos.' })
    }
}

export async function cambiarEstadoPedido(req, res) {
    const idPedido = Number(req.params.id)
    const estado = req.body?.estado

    if (!Number.isSafeInteger(idPedido) || idPedido < 1) {
        return res.status(400).json({ mensaje: 'El número de pedido no es válido.' })
    }
    if (!['listo', 'cancelado'].includes(estado)) {
        return res.status(400).json({ mensaje: 'El estado debe ser "listo" o "cancelado".' })
    }

    try {
        const resultado = await modificarPedidos((pedidos) => {
            const pedido = pedidos.find((actual) => actual.id_pedido === idPedido)
            if (!pedido) return 'no-encontrado'
            if (pedido.estado !== 'en preparación') return 'ya-procesado'

            pedido.estado = estado
            return 'actualizado'
        })

        if (resultado === 'no-encontrado') {
            return res.status(404).json({ mensaje: 'No se encontró ese pedido.' })
        }
        if (resultado === 'ya-procesado') {
            return res.status(409).json({ mensaje: 'El pedido ya fue procesado.' })
        }

        res.json({ mensaje: `Pedido ${idPedido} actualizado a "${estado}".`, id_pedido: idPedido, estado })
    } catch (error) {
        console.error('Error al cambiar el estado del pedido:', error)
        res.status(500).json({ mensaje: 'No se pudo actualizar el pedido.' })
    }
}

//3° Función para app.post('/api/v1/recetas') - Da de alta un nuevo plato
export function altaReceta(req, res) {
    const nuevaReceta = req.body
    const proximoId = Number(menu.ultimo_id) + 1 // Calcula el nuevo ID basado en el último

    nuevaReceta.id = proximoId
    menu.ultimo_id = proximoId // Actualiza el último ID en el objeto

    menu.datos.push(nuevaReceta)

    res.status(201).json({
        mensaje: "Plato dado de alta exitosamente",
        receta: nuevaReceta
    })
}

// 4° Función para app.put('/api/v1/recetas/:id') - Modifica un plato existente
export function modificarReceta(req, res) {
    const id_receta = Number(req.params.id)
    const recetaModificada = req.body
    let encontrada = false

    menu.datos.forEach((receta, indice) => {
        if (id_receta === Number(receta.id)) {
            recetaModificada.id = id_receta // Asegura que conserve su ID original
            menu.datos[indice] = recetaModificada
            encontrada = true
        }
    })

    if (encontrada) {
        res.json({
            mensaje: `Plato modificado con éxito con id ${id_receta}`
        })
    } else {
        res.status(404).json({
            mensaje: "No se encontró el plato que deseas modificar"
        })
    }
}

// 5° Función para app.delete('/api/v1/recetas/:id') - Elimina un plato existente
export function eliminarReceta(req, res) {
    const id_receta = Number(req.params.id)

    const recetasFiltradas = menu.datos.filter((receta) => {
        return id_receta !== Number(receta.id)
    })

    // Comprobamos si realmente se eliminó algún elemento
    if (recetasFiltradas.length < menu.datos.length) {
        menu.datos.length = 0
        menu.datos.push(...recetasFiltradas) // Actualiza el array original

        res.json({
            mensaje: `Plato con id ${id_receta} eliminado correctamente`
        })
    } else {
        res.status(404).json({
            mensaje: "No se encontró el plato que deseas eliminar"
        })
    }
}