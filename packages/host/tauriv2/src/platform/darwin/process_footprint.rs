//! The physical footprint of a process and its parts: the ledgers of task_info TASK_VM_INFO (mach/task_info.h of the macOS SDK,
//! revision 3), read through the task name port of task_name_for_pid (mach/mach_traps.h), which a process of the same user
//! grants. The mach2 crate declares the calls and task_vm_info; it has no TASK_VM_INFO_REV3_COUNT, which is written here.

use mach2::kern_return::KERN_SUCCESS;
use mach2::mach_port::mach_port_deallocate;
use mach2::message::mach_msg_type_number_t;
use mach2::port::{MACH_PORT_NULL, mach_port_name_t};
use mach2::task::task_info;
use mach2::task_info::{TASK_VM_INFO, task_vm_info};
use mach2::traps::{mach_task_self, task_name_for_pid};

use crate::platform::ProcessFootprint;

/// TASK_VM_INFO_REV3_COUNT of mach/task_info.h: the words of task_vm_info up to ledger_tag_neural_nofootprint_compressed.
const TASK_VM_INFO_REV3_COUNT: mach_msg_type_number_t = 84;

/// Returns the physical footprint of the process pid and its ledger parts (KB, each rounded down). The error names the failed
/// call and its kern_return_t, which the Go host also names.
pub fn process_footprint(pid: u32) -> Result<ProcessFootprint, String> {
    let process =
        libc::c_int::try_from(pid).map_err(|_| format!("pid {pid} is not a process id"))?;
    let mut name: mach_port_name_t = MACH_PORT_NULL;
    let code = unsafe { task_name_for_pid(mach_task_self(), process, &mut name) };
    if code != KERN_SUCCESS {
        return Err(format!(
            "task_name_for_pid for pid {pid}: kern_return {code}"
        ));
    }
    let mut info = task_vm_info::default();
    let mut count = TASK_VM_INFO_REV3_COUNT;
    let code = unsafe {
        task_info(
            name,
            TASK_VM_INFO,
            (&mut info as *mut task_vm_info).cast(),
            &mut count,
        )
    };
    let released = unsafe { mach_port_deallocate(mach_task_self(), name) };
    if code != KERN_SUCCESS {
        return Err(format!("task_info for pid {pid}: kern_return {code}"));
    }
    if released != KERN_SUCCESS {
        return Err(format!(
            "mach_port_deallocate for pid {pid}: kern_return {released}"
        ));
    }
    if count < TASK_VM_INFO_REV3_COUNT {
        return Err(format!(
            "task_info for pid {pid}: {count} of {TASK_VM_INFO_REV3_COUNT} words"
        ));
    }
    // Each ledger is a byte count that the kernel keeps at zero or above; a negative value is reported, not converted. The
    // order is the order of the Go host, so the first negative ledger names itself in both hosts.
    let ledgers: [(&str, i64); 13] = [
        ("phys_footprint", info.phys_footprint as i64),
        ("internal", info.internal as i64),
        ("compressed", info.compressed as i64),
        (
            "ledger_purgeable_nonvolatile",
            info.ledger_purgeable_nonvolatile,
        ),
        (
            "ledger_purgeable_novolatile_compressed",
            info.ledger_purgeable_novolatile_compressed,
        ),
        (
            "ledger_tag_graphics_footprint",
            info.ledger_tag_graphics_footprint,
        ),
        (
            "ledger_tag_graphics_footprint_compressed",
            info.ledger_tag_graphics_footprint_compressed,
        ),
        (
            "ledger_tag_media_footprint",
            info.ledger_tag_media_footprint,
        ),
        (
            "ledger_tag_media_footprint_compressed",
            info.ledger_tag_media_footprint_compressed,
        ),
        (
            "ledger_tag_network_nonvolatile",
            info.ledger_tag_network_nonvolatile,
        ),
        (
            "ledger_tag_network_nonvolatile_compressed",
            info.ledger_tag_network_nonvolatile_compressed,
        ),
        (
            "ledger_tag_neural_footprint",
            info.ledger_tag_neural_footprint,
        ),
        (
            "ledger_tag_neural_footprint_compressed",
            info.ledger_tag_neural_footprint_compressed,
        ),
    ];
    if let Some((ledger, value)) = ledgers.iter().find(|(_, value)| *value < 0) {
        return Err(format!("task_info for pid {pid}: {ledger} is {value}"));
    }
    let kb = |indexes: &[usize]| {
        indexes
            .iter()
            .map(|&index| ledgers[index].1 as u64)
            .sum::<u64>()
            / 1024
    };
    Ok(ProcessFootprint {
        total: kb(&[0]),
        internal: kb(&[1]),
        compressed: kb(&[2]),
        purgeable: kb(&[3, 4]),
        graphics: kb(&[5, 6]),
        media: kb(&[7, 8]),
        network: kb(&[9, 10]),
        neural: kb(&[11, 12]),
    })
}
