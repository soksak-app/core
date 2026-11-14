# Holds an exclusive flock on the file of its first argument and prints "held" once it holds it.
use Fcntl ":flock";
$| = 1;
open(my $f, "<", $ARGV[0]) or die;
flock($f, LOCK_EX) or die;
print "held\n";
sleep 60;
