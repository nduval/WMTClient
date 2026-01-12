<?php
/**
 * WMT Client - MUD Connection Handler
 * Handles WebSocket connections and proxies to the MUD server
 */

namespace WMT\WebSocket;

use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;

class MudHandler implements MessageComponentInterface
{
    protected $clients;
    protected $mudConnections;
    protected $userTriggers;
    protected $userAliases;
    protected $mudHost;
    protected $mudPort;

    public function __construct(string $mudHost = '3k.org', int $mudPort = 3000)
    {
        $this->clients = new \SplObjectStorage;
        $this->mudConnections = [];
        $this->userTriggers = [];
        $this->userAliases = [];
        $this->mudHost = $mudHost;
        $this->mudPort = $mudPort;

        echo "MUD Handler initialized for {$mudHost}:{$mudPort}\n";
    }

    public function onOpen(ConnectionInterface $conn)
    {
        $this->clients->attach($conn);
        $clientId = $conn->resourceId;

        echo "New connection: {$clientId}\n";

        // Send welcome message
        $conn->send(json_encode([
            'type' => 'system',
            'message' => "Welcome to WMT Client! Connecting to {$this->mudHost}:{$this->mudPort}..."
        ]));

        // Create MUD connection
        $this->connectToMud($conn);
    }

    protected function connectToMud(ConnectionInterface $conn)
    {
        $clientId = $conn->resourceId;

        // Create socket connection to MUD
        $socket = @stream_socket_client(
            "tcp://{$this->mudHost}:{$this->mudPort}",
            $errno,
            $errstr,
            30
        );

        if (!$socket) {
            $conn->send(json_encode([
                'type' => 'error',
                'message' => "Failed to connect to MUD: {$errstr} ({$errno})"
            ]));
            return;
        }

        // Set non-blocking mode
        stream_set_blocking($socket, false);

        $this->mudConnections[$clientId] = $socket;

        $conn->send(json_encode([
            'type' => 'system',
            'message' => "Connected to {$this->mudHost}:{$this->mudPort}!"
        ]));

        echo "MUD connection established for client {$clientId}\n";
    }

    public function onMessage(ConnectionInterface $from, $msg)
    {
        $clientId = $from->resourceId;
        $data = json_decode($msg, true);

        if (!$data) {
            return;
        }

        switch ($data['type'] ?? '') {
            case 'command':
                $this->handleCommand($from, $data['command'] ?? '');
                break;

            case 'set_triggers':
                $this->userTriggers[$clientId] = $data['triggers'] ?? [];
                break;

            case 'set_aliases':
                $this->userAliases[$clientId] = $data['aliases'] ?? [];
                break;

            case 'keepalive':
                // Respond to keepalive
                $from->send(json_encode(['type' => 'keepalive_ack']));
                break;

            case 'reconnect':
                $this->reconnectToMud($from);
                break;
        }
    }

    protected function handleCommand(ConnectionInterface $conn, string $command)
    {
        $clientId = $conn->resourceId;

        if (!isset($this->mudConnections[$clientId])) {
            $conn->send(json_encode([
                'type' => 'error',
                'message' => 'Not connected to MUD'
            ]));
            return;
        }

        // Process aliases
        $command = $this->processAliases($clientId, $command);

        // Handle multiple commands (separated by ;)
        $commands = $this->parseCommands($command);

        foreach ($commands as $cmd) {
            $cmd = trim($cmd);
            if ($cmd !== '') {
                // Send to MUD
                $socket = $this->mudConnections[$clientId];
                fwrite($socket, $cmd . "\r\n");
            }
        }
    }

    protected function parseCommands(string $input): array
    {
        // Split by semicolon, but respect escaped semicolons
        $commands = [];
        $current = '';
        $escaped = false;

        for ($i = 0; $i < strlen($input); $i++) {
            $char = $input[$i];

            if ($escaped) {
                $current .= $char;
                $escaped = false;
            } elseif ($char === '\\') {
                $escaped = true;
            } elseif ($char === ';') {
                $commands[] = $current;
                $current = '';
            } else {
                $current .= $char;
            }
        }

        if ($current !== '') {
            $commands[] = $current;
        }

        return $commands;
    }

    protected function processAliases(int $clientId, string $command): string
    {
        if (!isset($this->userAliases[$clientId])) {
            return $command;
        }

        $parts = explode(' ', $command, 2);
        $cmd = $parts[0];
        $args = $parts[1] ?? '';

        foreach ($this->userAliases[$clientId] as $alias) {
            if (!($alias['enabled'] ?? true)) {
                continue;
            }

            if (strtolower($cmd) === strtolower($alias['pattern'])) {
                $replacement = $alias['replacement'];

                // Replace $* with all arguments
                $replacement = str_replace('$*', $args, $replacement);

                // Replace $1, $2, etc. with individual arguments
                $argParts = preg_split('/\s+/', $args);
                for ($i = 0; $i < count($argParts); $i++) {
                    $replacement = str_replace('$' . ($i + 1), $argParts[$i], $replacement);
                }

                // Clean up unused variables
                $replacement = preg_replace('/\$\d+/', '', $replacement);
                $replacement = preg_replace('/\$\*/', '', $replacement);

                return trim($replacement);
            }
        }

        return $command;
    }

    protected function processTriggers(int $clientId, string $line): array
    {
        $result = [
            'line' => $line,
            'gag' => false,
            'highlight' => null,
            'commands' => [],
            'sound' => null
        ];

        if (!isset($this->userTriggers[$clientId])) {
            return $result;
        }

        foreach ($this->userTriggers[$clientId] as $trigger) {
            if (!($trigger['enabled'] ?? true)) {
                continue;
            }

            $matched = false;
            $matches = [];

            switch ($trigger['matchType'] ?? 'contains') {
                case 'exact':
                    $matched = (strtolower($line) === strtolower($trigger['pattern']));
                    break;

                case 'contains':
                    $matched = (stripos($line, $trigger['pattern']) !== false);
                    break;

                case 'startsWith':
                    $matched = (stripos($line, $trigger['pattern']) === 0);
                    break;

                case 'endsWith':
                    $matched = (substr(strtolower($line), -strlen($trigger['pattern'])) === strtolower($trigger['pattern']));
                    break;

                case 'regex':
                    $matched = @preg_match('/' . $trigger['pattern'] . '/i', $line, $matches);
                    break;
            }

            if ($matched) {
                // Apply actions
                foreach ($trigger['actions'] ?? [] as $action) {
                    switch ($action['type']) {
                        case 'gag':
                            $result['gag'] = true;
                            break;

                        case 'highlight':
                            $result['highlight'] = $action['color'] ?? '#ffff00';
                            break;

                        case 'command':
                            $cmd = $action['command'] ?? '';
                            // Replace $0 with full match, $1, $2, etc. with groups
                            if (!empty($matches)) {
                                foreach ($matches as $i => $match) {
                                    $cmd = str_replace('$' . $i, $match, $cmd);
                                }
                            }
                            $result['commands'][] = $cmd;
                            break;

                        case 'sound':
                            $result['sound'] = $action['sound'] ?? 'beep';
                            break;
                    }
                }
            }
        }

        return $result;
    }

    protected function reconnectToMud(ConnectionInterface $conn)
    {
        $clientId = $conn->resourceId;

        // Close existing connection if any
        if (isset($this->mudConnections[$clientId])) {
            fclose($this->mudConnections[$clientId]);
            unset($this->mudConnections[$clientId]);
        }

        $conn->send(json_encode([
            'type' => 'system',
            'message' => "Reconnecting to {$this->mudHost}:{$this->mudPort}..."
        ]));

        $this->connectToMud($conn);
    }

    public function onClose(ConnectionInterface $conn)
    {
        $clientId = $conn->resourceId;

        // Close MUD connection
        if (isset($this->mudConnections[$clientId])) {
            fclose($this->mudConnections[$clientId]);
            unset($this->mudConnections[$clientId]);
        }

        // Clean up
        unset($this->userTriggers[$clientId]);
        unset($this->userAliases[$clientId]);

        $this->clients->detach($conn);
        echo "Connection {$clientId} closed\n";
    }

    public function onError(ConnectionInterface $conn, \Exception $e)
    {
        echo "Error: {$e->getMessage()}\n";
        $conn->close();
    }

    /**
     * Called periodically to read from MUD connections and send to clients
     */
    public function tick()
    {
        foreach ($this->clients as $conn) {
            $clientId = $conn->resourceId;

            if (!isset($this->mudConnections[$clientId])) {
                continue;
            }

            $socket = $this->mudConnections[$clientId];

            // Check if socket is still valid
            if (!is_resource($socket) || feof($socket)) {
                $conn->send(json_encode([
                    'type' => 'system',
                    'message' => 'Connection to MUD lost.'
                ]));
                fclose($socket);
                unset($this->mudConnections[$clientId]);
                continue;
            }

            // Read available data
            $data = '';
            while (($chunk = @fread($socket, 4096)) !== false && $chunk !== '') {
                $data .= $chunk;
            }

            if ($data !== '') {
                // Split into lines and process
                $lines = explode("\n", $data);

                foreach ($lines as $line) {
                    if ($line === '') {
                        continue;
                    }

                    // Process triggers
                    $processed = $this->processTriggers($clientId, $line);

                    // Skip gagged lines
                    if ($processed['gag']) {
                        continue;
                    }

                    // Send to client
                    $conn->send(json_encode([
                        'type' => 'mud',
                        'line' => $processed['line'],
                        'highlight' => $processed['highlight'],
                        'sound' => $processed['sound']
                    ]));

                    // Execute trigger commands
                    foreach ($processed['commands'] as $cmd) {
                        $this->handleCommand($conn, $cmd);
                    }
                }
            }
        }
    }
}
