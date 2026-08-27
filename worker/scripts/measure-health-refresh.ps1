param(
    [Parameter(Mandatory = $true)]
    [string]$WorkerUrl,

    [string]$DeviceId = "esp32-monitor-01",

    [SecureString]$AdminApiKey,

    [ValidateRange(5, 300)]
    [int]$TimeoutSeconds = 45,

    [ValidateRange(100, 5000)]
    [int]$PollIntervalMilliseconds = 500
)

$ErrorActionPreference = "Stop"
$WorkerUrl = $WorkerUrl.TrimEnd("/")

if ($null -eq $AdminApiKey) {
    $AdminApiKey = Read-Host "Admin API key" -AsSecureString
}

$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminApiKey)
try {
    $plainAdminApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    $headers = @{ "X-Admin-Key" = $plainAdminApiKey }
    $requestBody = @{ deviceId = $DeviceId } | ConvertTo-Json
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()

    $queueRequest = @{
        Method = "Post"
        Uri = "$WorkerUrl/v1/status-requests"
        Headers = $headers
        ContentType = "application/json"
        Body = $requestBody
    }
    $queued = Invoke-RestMethod @queueRequest

    if ($queued.duplicate) {
        throw "A health refresh is already queued as $($queued.commandId). Wait for it to finish, then run the measurement again."
    }

    Write-Host "Queued health refresh $($queued.commandId); waiting for the ESP32..."
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $command = $null

    do {
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
        $commandRequest = @{
            Method = "Get"
            Uri = "$WorkerUrl/v1/commands/$($queued.commandId)"
            Headers = $headers
        }
        $command = Invoke-RestMethod @commandRequest

        if ($command.status -eq "completed") {
            $stopwatch.Stop()
            $result = if ($command.result_json) { $command.result_json | ConvertFrom-Json } else { $null }
            [pscustomobject]@{
                DeviceId = $DeviceId
                CommandId = $queued.commandId
                ElapsedMilliseconds = $stopwatch.ElapsedMilliseconds
                RequestedAt = $queued.requestedAt
                CompletedAt = $command.completed_at
                WorkerReceivedAt = $result.receivedAt
                State = $result.state
                Ip = $result.ip
            }
            return
        }

        if ($command.status -in @("failed", "expired")) {
            throw "Health refresh ended with status '$($command.status)': $($command.result_json)"
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Timed out after $TimeoutSeconds seconds. Confirm the ESP32 is online, running firmware 0.4.0+, and polling commands."
}
finally {
    if ($secretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    }
    Remove-Variable plainAdminApiKey -ErrorAction SilentlyContinue
}
