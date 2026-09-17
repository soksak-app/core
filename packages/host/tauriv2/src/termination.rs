//! 운영체제의 종료 요청.

use crate::platform;

/// 운영체제의 종료 요청을 받으면 quit 를 한 번 호출하게 한다. 그 뒤의 종료 요청은 운영체제의
/// 기본 동작으로 프로세스를 끝낸다.
pub fn on_termination(quit: Box<dyn Fn() + Send>) -> Result<(), String> {
    platform::current()?.on_termination(quit)
}
