package com.wirelessgamemirror.sender

import android.content.Context
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper

data class DiscoveredPCReceiver(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val sessionToken: String? = null,
    val authMethod: String = if (!sessionToken.isNullOrBlank()) "qr-token" else "mdns-prompt"
) {
    val wsUrl: String
        get() = if (!sessionToken.isNullOrBlank()) {
            "ws://$host:$port/ws?token=${Uri.encode(sessionToken)}"
        } else {
            "ws://$host:$port/ws"
        }
}

/**
 * Discovers PC Receivers on the local LAN via mDNS (`_gamestream._tcp.`) using Android `NsdManager`
 * and parses QR Code pairing URIs (`gamemirror://connect?ip=...&port=...&token=...`).
 */
class MdnsDiscoveryManager(
    context: Context,
    private val onReceiversUpdated: (List<DiscoveredPCReceiver>) -> Unit
) {
    companion object {
        const val SERVICE_TYPE = "_gamestream._tcp."

        fun parseQrCodePayload(rawText: String): DiscoveredPCReceiver? {
            val trimmed = rawText.trim()
            if (trimmed.isEmpty()) return null

            val uri = try {
                Uri.parse(trimmed)
            } catch (_: Exception) {
                return null
            }

            if (uri.scheme?.lowercase() == "gamemirror") {
                val ip = uri.getQueryParameter("ip") ?: return null
                val port = uri.getQueryParameter("port")?.toIntOrNull() ?: 8080
                val token = uri.getQueryParameter("token")
                val name = uri.getQueryParameter("name") ?: "PC Receiver ($ip)"
                return DiscoveredPCReceiver(
                    id = "$ip:$port",
                    name = name,
                    host = ip,
                    port = port,
                    sessionToken = token,
                    authMethod = if (!token.isNullOrBlank()) "qr-token" else "mdns-prompt"
                )
            }

            val host = uri.getQueryParameter("ip") ?: uri.host ?: return null
            val port = uri.getQueryParameter("port")?.toIntOrNull() ?: if (uri.port > 0) uri.port else 8080
            val token = uri.getQueryParameter("token")
            val name = uri.getQueryParameter("name") ?: "PC Receiver ($host)"
            return DiscoveredPCReceiver(
                id = "$host:$port",
                name = name,
                host = host,
                port = port,
                sessionToken = token,
                authMethod = if (!token.isNullOrBlank()) "qr-token" else "mdns-prompt"
            )
        }
    }

    private val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val receivers = linkedMapOf<String, DiscoveredPCReceiver>()
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var isResolving = false
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var isDiscovering = false

    private fun enqueueResolve(service: NsdServiceInfo) {
        mainHandler.post {
            resolveQueue.addLast(service)
            processNextResolve()
        }
    }

    private fun processNextResolve() {
        if (isResolving || resolveQueue.isEmpty()) return
        val nextService = resolveQueue.removeFirst()
        isResolving = true

        try {
            nsdManager.resolveService(nextService, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    mainHandler.post {
                        isResolving = false
                        processNextResolve()
                    }
                }

                override fun onServiceResolved(resolvedInfo: NsdServiceInfo) {
                    val hostAddress = resolvedInfo.host?.hostAddress
                    if (hostAddress != null) {
                        val cleanIp = hostAddress.substringBefore("%")
                        val receiver = DiscoveredPCReceiver(
                            id = "$cleanIp:${resolvedInfo.port}",
                            name = resolvedInfo.serviceName ?: "PC Receiver ($cleanIp)",
                            host = cleanIp,
                            port = resolvedInfo.port,
                            sessionToken = null, // mDNS requires PC Allow/Deny prompt
                            authMethod = "mdns-prompt"
                        )
                        mainHandler.post {
                            receivers[receiver.id] = receiver
                            onReceiversUpdated(receivers.values.toList())
                            isResolving = false
                            processNextResolve()
                        }
                    } else {
                        mainHandler.post {
                            isResolving = false
                            processNextResolve()
                        }
                    }
                }
            })
        } catch (_: Exception) {
            isResolving = false
            processNextResolve()
        }
    }

    fun startDiscovery() {
        if (isDiscovering) return

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
                isDiscovering = true
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                if (!service.serviceType.contains("_gamestream._tcp")) return
                enqueueResolve(service)
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                val lostName = service.serviceName ?: return
                mainHandler.post {
                    val iterator = receivers.entries.iterator()
                    var changed = false
                    while (iterator.hasNext()) {
                        if (iterator.next().value.name == lostName) {
                            iterator.remove()
                            changed = true
                        }
                    }
                    if (changed) {
                        onReceiversUpdated(receivers.values.toList())
                    }
                }
            }
            override fun onDiscoveryStopped(serviceType: String) {
                isDiscovering = false
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                isDiscovering = false
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                isDiscovering = false
            }
        }

        discoveryListener = listener
        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: Exception) {
            isDiscovering = false
        }
    }

    fun stopDiscovery() {
        val listener = discoveryListener ?: return
        discoveryListener = null
        if (isDiscovering) {
            try {
                nsdManager.stopServiceDiscovery(listener)
            } catch (_: Exception) {
            }
        }
        isDiscovering = false
    }
}
