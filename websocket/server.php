<?php
/**
 * WMT Client - WebSocket Server
 *
 * Usage: php websocket/server.php
 */

require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/../config/config.php';
require __DIR__ . '/MudHandler.php';

use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;
use WMT\WebSocket\MudHandler;
use React\EventLoop\Loop;

echo "========================================\n";
echo "       WMT Client WebSocket Server\n";
echo "========================================\n";
echo "MUD Server: " . MUD_HOST . ":" . MUD_PORT . "\n";
echo "WebSocket: ws://" . WS_HOST . ":" . WS_PORT . "\n";
echo "========================================\n\n";

// Create the event loop
$loop = Loop::get();

// Create the MUD handler
$mudHandler = new MudHandler(MUD_HOST, MUD_PORT);

// Create WebSocket server
$wsServer = new WsServer($mudHandler);
$wsServer->enableKeepAlive($loop, 30);

// Create HTTP server wrapper
$httpServer = new HttpServer($wsServer);

// Create the socket server
$socket = new React\Socket\SocketServer(WS_HOST . ':' . WS_PORT, [], $loop);
$server = new IoServer($httpServer, $socket, $loop);

// Add periodic timer to read from MUD connections
$loop->addPeriodicTimer(0.05, function() use ($mudHandler) {
    $mudHandler->tick();
});

echo "Server started. Press Ctrl+C to stop.\n\n";

// Run the server
$loop->run();
