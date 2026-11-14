# Opens the file of its first argument twice, holds an exclusive flock on the first open file description and prints "held" once it
# holds it, so the process has the file open on two descriptors and holds the lock on one of them.
use Fcntl ":flock";
$| = 1;
open(my $first, "<", $ARGV[0]) or die;
open(my $second, "<", $ARGV[0]) or die;
flock($first, LOCK_EX) or die;
print "held\n";
sleep 60;
