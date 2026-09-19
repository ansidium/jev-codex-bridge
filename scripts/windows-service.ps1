param(
    [Parameter(Mandatory)][ValidateSet('install','start','stop','restart','status','remove','schedule','refresh')][string]$Action,
    [Parameter(Mandatory)][string]$BridgeHome,
    [Parameter(Mandatory)][string]$Node,
    [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')][string]$UpdateTime
)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $BridgeHome 'settings.json') -Raw | ConvertFrom-Json
$taskName = $settings.taskName
$updateTaskName = $taskName + '-Update'
$launcher = Join-Path $BridgeHome 'launch.mjs'

function New-ServiceAction([string]$Mode) {
    $source = Join-Path $PSScriptRoot 'WindowsServiceHost.cs'
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
    $serviceHostPath = Join-Path $BridgeHome ('service-host-' + $hash + '.exe')
    if (-not (Test-Path -LiteralPath $serviceHostPath)) {
        Add-Type -Path $source -OutputAssembly $serviceHostPath -OutputType WindowsApplication
    }
    $arguments = '"' + $BridgeHome + '" "' + $Node + '" ' + $Mode
    New-ScheduledTaskAction -Execute $serviceHostPath -Argument $arguments -WorkingDirectory $BridgeHome
}

function Update-ServiceActions {
    foreach ($mode in @('serve','update')) {
        $name = if ($mode -eq 'serve') { $taskName } else { $updateTaskName }
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $name -Action (New-ServiceAction $mode) | Out-Null
        }
    }
}

if ($Action -eq 'install') {
    foreach ($name in @($taskName, $updateTaskName)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw "Task $name already exists; choose a different --task-name." }
    }
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    foreach ($mode in @('serve','update')) {
        $taskAction = New-ServiceAction $mode
        if ($mode -eq 'serve') {
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
            $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
            $name = $taskName
        } else {
            $trigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::ParseExact($settings.updateTime, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture))
            $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
            $name = $updateTaskName
        }
        Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Principal $principal -Settings $taskSettings -Description 'Jev Codex Bridge managed installation' | Out-Null
    }
    Start-ScheduledTask -TaskName $taskName
} elseif ($Action -eq 'schedule') {
    if (-not $UpdateTime) { throw 'Provide UpdateTime in HH:mm format.' }
    $trigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::ParseExact($UpdateTime, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture))
    Set-ScheduledTask -TaskName $updateTaskName -Trigger $trigger | Out-Null
    Write-Output ('Update schedule: daily at ' + $UpdateTime + ' local time')
} elseif ($Action -eq 'status') {
    Get-ScheduledTask -TaskName $taskName,$updateTaskName | Select-Object TaskName,State
} elseif ($Action -eq 'refresh') {
    Update-ServiceActions
} else {
    if ($Action -in @('stop','restart','remove')) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq 'Running') {
            & $Node $launcher shutdown
            if ($LASTEXITCODE -ne 0) { throw 'Graceful shutdown failed; no process was killed.' }
            $until = [DateTime]::UtcNow.AddSeconds(15)
            do {
                Start-Sleep -Milliseconds 100
                $task = Get-ScheduledTask -TaskName $taskName
            } while ($task.State -eq 'Running' -and [DateTime]::UtcNow -lt $until)
            if ($task.State -eq 'Running') { throw 'Service is still stopping; retry later.' }
        }
    }
    if ($Action -in @('start','restart')) {
        Update-ServiceActions
        Start-ScheduledTask -TaskName $taskName
    }
    if ($Action -eq 'remove') {
        foreach ($name in @($taskName, $updateTaskName)) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
            }
        }
    }
}
