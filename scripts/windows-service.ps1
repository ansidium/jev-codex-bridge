param(
    [Parameter(Mandatory)][ValidateSet('install','start','stop','restart','status','remove')][string]$Action,
    [Parameter(Mandatory)][string]$BridgeHome,
    [Parameter(Mandatory)][string]$Node
)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $BridgeHome 'settings.json') -Raw | ConvertFrom-Json
$taskName = $settings.taskName
$updateTaskName = $taskName + '-Update'
$launcher = Join-Path $BridgeHome 'launch.mjs'
$runner = Join-Path $BridgeHome 'run-service.ps1'

if ($Action -eq 'install') {
    foreach ($name in @($taskName, $updateTaskName)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw "Task $name already exists; choose a different --task-name." }
    }
    # Task Scheduler owns this hidden foreground process, independent of Codex.
    $runnerText = @'
param([string]$Node, [string]$Mode)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$log = Join-Path $PSScriptRoot ($Mode + '.log')
if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) {
    Move-Item -LiteralPath $log -Destination ($log + '.previous') -Force
}
& $Node (Join-Path $PSScriptRoot 'launch.mjs') $Mode --automatic *>> $log
exit $LASTEXITCODE
'@
    [IO.File]::WriteAllText($runner, $runnerText, [Text.UTF8Encoding]::new($false))
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    foreach ($mode in @('serve','update')) {
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '" -Node "' + $Node + '" -Mode ' + $mode
        $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $BridgeHome
        if ($mode -eq 'serve') {
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
            $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
            $name = $taskName
        } else {
            $trigger = New-ScheduledTaskTrigger -Daily -At '10:00'
            $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
            $name = $updateTaskName
        }
        Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Principal $principal -Settings $taskSettings -Description 'Jev Codex Bridge managed installation' | Out-Null
    }
    Start-ScheduledTask -TaskName $taskName
} elseif ($Action -eq 'status') {
    Get-ScheduledTask -TaskName $taskName,$updateTaskName | Select-Object TaskName,State
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
    if ($Action -in @('start','restart')) { Start-ScheduledTask -TaskName $taskName }
    if ($Action -eq 'remove') {
        foreach ($name in @($taskName, $updateTaskName)) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
            }
        }
    }
}
