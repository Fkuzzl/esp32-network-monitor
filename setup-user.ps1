$ErrorActionPreference = "Stop"

function Read-EnvFile([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing $Path. Copy .env.example to .env and fill it first."
    }
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) { continue }
        $parts = $trimmed.Split('=', 2)
        if ($parts.Count -ne 2) { throw "Invalid provider line: $trimmed" }
        $values[$parts[0].Trim()] = $parts[1].Trim()
    }
    return $values
}

function New-Secret {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function ConvertTo-PlainText([Security.SecureString] $Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function ConvertTo-CppString([string] $Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r", '').Replace("`n", '\n')
}

function Write-Utf8NoBom([string] $Path, [string] $Content) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Resolve-Path -LiteralPath (Split-Path -Parent $Path)).Path + "\" + (Split-Path -Leaf $Path), $Content, $utf8)
}

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$outputFiles = @(
    (Join-Path $root '.env.local'),
    (Join-Path $root 'worker\.dev.vars'),
    (Join-Path $root 'worker\wrangler.jsonc'),
    (Join-Path $root 'esp32\NetworkMonitor\config.h')
)
$existing = $outputFiles | Where-Object { Test-Path -LiteralPath $_ }
if ($existing) {
    throw "Refusing to overwrite existing local configuration. Remove or back up the existing generated files first: $($existing -join ', ')"
}
$providerPath = Join-Path $root ".env"
$provider = Read-EnvFile $providerPath
foreach ($required in @('OPENROUTER_MODEL','OPENROUTER_API_KEY','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID')) {
    if (-not $provider.ContainsKey($required) -or [string]::IsNullOrWhiteSpace($provider[$required]) -or $provider[$required] -like 'replace-with-*') {
        throw "$required is missing or still uses a placeholder in .env"
    }
}

$workerName = Read-Host "Cloudflare Worker name [esp32-network-monitor]"
if ([string]::IsNullOrWhiteSpace($workerName)) { $workerName = "esp32-network-monitor" }
$databaseName = Read-Host "D1 database name [esp32-network-monitor]"
if ([string]::IsNullOrWhiteSpace($databaseName)) { $databaseName = "esp32-network-monitor" }
$databaseId = Read-Host "D1 database ID"
if ([string]::IsNullOrWhiteSpace($databaseId)) { throw "D1 database ID is required" }
$workerUrl = Read-Host "Deployed Worker URL (for example https://example.workers.dev)"
$workerUri = $null
if (-not [Uri]::TryCreate($workerUrl, [UriKind]::Absolute, [ref] $workerUri) -or $workerUri.Scheme -ne 'https') {
    throw "Worker URL must be a valid https:// URL"
}
$workerUrl = $workerUrl.TrimEnd('/')
$wifiSsid = Read-Host "Wi-Fi SSID"
if ([string]::IsNullOrWhiteSpace($wifiSsid)) { throw "Wi-Fi SSID is required" }
$wifiPasswordSecure = Read-Host "Wi-Fi password" -AsSecureString
$wifiPassword = ConvertTo-PlainText $wifiPasswordSecure
$deviceId = Read-Host "ESP32 device ID [esp32-monitor-01]"
if ([string]::IsNullOrWhiteSpace($deviceId)) { $deviceId = "esp32-monitor-01" }
if ($deviceId -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw "Device ID must use 1-64 letters, numbers, underscores, or hyphens" }
$reportTimezone = Read-Host "Worker report timezone [Asia/Shanghai]"
if ([string]::IsNullOrWhiteSpace($reportTimezone)) { $reportTimezone = 'Asia/Shanghai' }
$firmwareTimezone = Read-Host "ESP32 POSIX timezone [CST-8]"
if ([string]::IsNullOrWhiteSpace($firmwareTimezone)) { $firmwareTimezone = 'CST-8' }
$caPath = Read-Host "Root CA PEM file path for the Worker HTTPS certificate"
if (-not (Test-Path -LiteralPath $caPath)) { throw "Root CA PEM file was not found" }
$caPem = Get-Content -Raw -LiteralPath $caPath
if ($caPem -notmatch '-----BEGIN CERTIFICATE-----' -or $caPem -notmatch '-----END CERTIFICATE-----') { throw "The CA file does not contain a PEM certificate" }
$caLiteral = $caPem.Replace('\', '\\').Replace('"', '\"').Replace("`r", '').Replace("`n", '\n')

$adminKey = New-Secret
$esp32Token = New-Secret
$webhookSecret = New-Secret

$localEnv = @"
OPENROUTER_MODEL=$($provider['OPENROUTER_MODEL'])
OPENROUTER_API_KEY=$($provider['OPENROUTER_API_KEY'])
TELEGRAM_BOT_TOKEN=$($provider['TELEGRAM_BOT_TOKEN'])
TELEGRAM_CHAT_ID=$($provider['TELEGRAM_CHAT_ID'])
ADMIN_API_KEY=$adminKey
ESP32_DEVICE_TOKEN=$esp32Token
TELEGRAM_WEBHOOK_SECRET=$webhookSecret
WORKER_BASE_URL=$workerUrl
DEVICE_ID=$deviceId
"@.Trim() + "`n"

$workerConfig = [ordered]@{
    '$schema' = 'node_modules/wrangler/config-schema.json'
    name = $workerName
    main = 'src/index.ts'
    compatibility_date = '2026-08-28'
    compatibility_flags = @('nodejs_compat')
    d1_databases = @([ordered]@{ binding = 'DB'; database_name = $databaseName; database_id = $databaseId; migrations_dir = 'migrations' })
    vars = [ordered]@{ REPORT_TIMEZONE = $reportTimezone; OPENROUTER_MODEL = $provider['OPENROUTER_MODEL']; MAX_COMMAND_AGE_SECONDS = '900'; DATA_RETENTION_DAYS = '31'; DEVICE_ID = $deviceId }
    observability = [ordered]@{ enabled = $true }
    secrets = [ordered]@{ required = @('OPENROUTER_API_KEY','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','TELEGRAM_WEBHOOK_SECRET','ESP32_DEVICE_TOKEN','ADMIN_API_KEY') }
} | ConvertTo-Json -Depth 8

$devVars = @"
OPENROUTER_MODEL=$($provider['OPENROUTER_MODEL'])
OPENROUTER_API_KEY=$($provider['OPENROUTER_API_KEY'])
TELEGRAM_BOT_TOKEN=$($provider['TELEGRAM_BOT_TOKEN'])
TELEGRAM_CHAT_ID=$($provider['TELEGRAM_CHAT_ID'])
ADMIN_API_KEY=$adminKey
ESP32_DEVICE_TOKEN=$esp32Token
TELEGRAM_WEBHOOK_SECRET=$webhookSecret
REPORT_TIMEZONE=$reportTimezone
MAX_COMMAND_AGE_SECONDS=900
DATA_RETENTION_DAYS=31
DEVICE_ID=$deviceId
"@.Trim() + "`n"

$configTemplate = Get-Content -Raw (Join-Path $root 'esp32\NetworkMonitor\config.example.h')
$config = $configTemplate.Replace('YOUR_WIFI_SSID', (ConvertTo-CppString $wifiSsid)).Replace('YOUR_WIFI_PASSWORD', (ConvertTo-CppString $wifiPassword)).Replace('YOUR_ESP32_DEVICE_TOKEN', (ConvertTo-CppString $esp32Token)).Replace('YOUR_WORKER_ROOT_CA_PEM', $caLiteral).Replace('https://replace-with-worker-url.workers.dev', (ConvertTo-CppString $workerUrl)).Replace('esp32-monitor-01', (ConvertTo-CppString $deviceId)).Replace('CST-8', (ConvertTo-CppString $firmwareTimezone))

Write-Utf8NoBom (Join-Path $root '.env.local') $localEnv
Write-Utf8NoBom (Join-Path $root 'worker\wrangler.jsonc') $workerConfig
Write-Utf8NoBom (Join-Path $root 'worker\.dev.vars') $devVars
Write-Utf8NoBom (Join-Path $root 'esp32\NetworkMonitor\config.h') $config

$wifiPassword = $null
$wifiPasswordSecure.Dispose()

Write-Host "Generated local configuration files without printing secret values."
Write-Host "Next: apply migrations, upload Wrangler secrets, deploy, register the Telegram webhook, and upload the ESP32 firmware."
