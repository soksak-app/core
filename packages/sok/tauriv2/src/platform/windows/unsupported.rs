use super::super::Platform;
use super::Windows;

impl Platform for Windows {
    fn process_running(&self, _pid: i32) -> Result<(), String> {
        Err("not implemented on windows".into())
    }
}
